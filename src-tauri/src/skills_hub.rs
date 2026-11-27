//! Skills hub H2 (`docs/plans/SKILLS_HUB.md` R1, R14, R16, R17, §7.1): the
//! team library keeps itself current.
//!
//! **The scheduler.** One thread, started in `setup`, pulls the team clone a
//! little after launch, then every 10 minutes (± up to a minute, so a team's
//! Macs don't all ask GitHub in the same second), and on wake from sleep when
//! the last pull is older than that. A wake is seen the same way on macOS and
//! Windows: a tick that finds the wall clock jumped by more than twice the
//! interval since the tick before. It takes no App Nap assertion: with the
//! window hidden and idle macOS may coalesce its timer, and the pull then runs
//! at the next tick.
//!
//! **One pull at a time.** The background pull and Settings › Team's Refresh
//! are the same pull ([`team_pull`]): a second one asked for while one runs
//! waits for it and gets its answer, rather than pulling again.
//!
//! **A pull never changes a running session** (H1's snapshots); it reaches
//! sessions started after it. What it changed, by someone else, becomes one
//! toast (`skills-hub://pulled`), never one per skill.
//!
//! **When GitHub stops answering** (R16), sessions keep the last copy and the
//! team section says when it was last updated. When GitHub refuses the
//! repository to the account this Mac was a member as, three times over at
//! least 30 minutes, Plyloft asks (an Inbox row and the section notice)
//! whether to switch the library off on this Mac; it switches nothing off
//! until the member says so. **When the team's manifest no longer lists that
//! account** (R17), this Mac has left the team: the clone goes to the Trash /
//! Recycle Bin and sessions get no team skills; the copies in repositories
//! stay as they are.
//!
//! **Exit (Hard rule 4).** `run_exit_cleanup` calls [`stop`] before the
//! bounded git children are killed: no new pull starts, and one in flight —
//! its fetch runs in the exit registry (`team::RealLibraryGit::pull`) — is
//! killed with them. No PTY, no agent, no new long-lived child process.
//!
//! Every git here runs on the library clone through
//! `team::library_git_capture` (Windows long paths), and the pull itself is
//! `TeamStore::sync`, which heals a torn fast-forward first.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::skills_hub_state::{team_key, LibraryState};
use crate::team::{Membership, SyncOutcome, TeamStatus};

/// R1: every 10 minutes.
pub(crate) const INTERVAL: Duration = Duration::from_secs(600);
/// R1: ± this much, at most a tenth of the interval.
const JITTER: Duration = Duration::from_secs(60);
/// After launch: the window shows first, then the pull (R1 AC: level within
/// 60 s of the window showing).
const STARTUP_DELAY: Duration = Duration::from_secs(10);
/// The longest the scheduler sleeps between two looks at the clock.
const MAX_TICK: Duration = Duration::from_secs(60);
/// R16: three refusals…
const ACCESS_LOST_AFTER: u32 = 3;
/// …over at least 30 minutes.
const ACCESS_LOST_SPAN_MS: i64 = 30 * 60 * 1000;

/// What a pull brought, by someone else: the toast.
pub(crate) const PULLED_EVENT: &str = "skills-hub://pulled";
/// The library's pull record changed: "Updated …", the notices.
pub(crate) const LIBRARY_EVENT: &str = "skills-hub://library";
/// An Inbox-worthy state appeared or resolved (shared with H6a).
pub(crate) const DECISION_EVENT: &str = "skills-hub://decision";

/// Why a pull runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Trigger {
    /// The first pull after launch.
    Startup,
    /// The 10-minute cadence.
    Timer,
    /// Back from sleep with the last pull older than the interval.
    Wake,
    /// Settings › Team opened or *Read it again* pressed.
    Refresh,
    /// After a team write.
    AfterWrite,
}

impl Trigger {
    /// Background pulls follow the team gate and the member's switch; a
    /// Refresh is the member asking, and reading a team stays free.
    fn background(self) -> bool {
        !matches!(self, Trigger::Refresh)
    }
}

// ── The scheduler ───────────────────────────────────────────────────

static STOP: AtomicBool = AtomicBool::new(false);

struct Queue {
    asked: parking_lot::Mutex<Option<Trigger>>,
    wake: parking_lot::Condvar,
}

fn queue() -> &'static Queue {
    static QUEUE: Queue = Queue {
        asked: parking_lot::Mutex::new(None),
        wake: parking_lot::Condvar::new(),
    };
    &QUEUE
}

/// Dev-only (`test-bridge`, debug builds): the Tier 4 walks run the cadence
/// at seconds instead of 10 minutes. A release build has no way to set it.
#[cfg(all(feature = "test-bridge", debug_assertions))]
static INTERVAL_OVERRIDE_SECS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(all(feature = "test-bridge", debug_assertions))]
pub(crate) fn set_interval_override(secs: u64) {
    INTERVAL_OVERRIDE_SECS.store(secs, Ordering::SeqCst);
    // The next tick uses it.
    queue().wake.notify_all();
}

/// The cadence in force.
pub(crate) fn interval() -> Duration {
    #[cfg(all(feature = "test-bridge", debug_assertions))]
    {
        let secs = INTERVAL_OVERRIDE_SECS.load(Ordering::SeqCst);
        if secs > 0 {
            return Duration::from_secs(secs);
        }
    }
    INTERVAL
}

/// Called once from `setup`. The thread does nothing but wait between pulls.
pub(crate) fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("skills-hub".into())
        .spawn(move || run(app));
    if let Err(error) = spawned {
        log::warn!("skills hub: couldn't start the background pull: {error}");
    }
}

/// `run_exit_cleanup`: no new pull starts after this.
pub(crate) fn stop() {
    STOP.store(true, Ordering::SeqCst);
    queue().wake.notify_all();
}

fn stopping() -> bool {
    STOP.load(Ordering::SeqCst)
}

/// Ask for a pull soon (after a team write). Several asks before the
/// scheduler wakes are one pull.
pub(crate) fn nudge(trigger: Trigger) {
    let q = queue();
    q.asked.lock().get_or_insert(trigger);
    q.wake.notify_all();
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// ± up to [`JITTER`] (a tenth of the interval at most), from the clock's
/// low bits: not a secret, only a spread.
fn jitter_ms(interval: Duration) -> i64 {
    let spread = JITTER.min(interval / 10).as_millis() as i64;
    if spread == 0 {
        return 0;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as i64)
        .unwrap_or(0);
    nanos % (2 * spread + 1) - spread
}

/// How long to sleep between looks at the clock: short enough to see a wake
/// and the next due time, never more than a minute.
/// How long the loop sleeps before it looks at the clock again: a tick, but
/// never past the next due pull. (Walk of H2: the first look came a whole
/// tick — 60 s — after launch, so the 10 s startup pull waited for it.)
pub(crate) fn sleep_for(now: i64, next_due: i64, interval: Duration) -> Duration {
    let until_due = Duration::from_millis(next_due.saturating_sub(now).max(0) as u64);
    tick(interval).min(until_due)
}

fn tick(interval: Duration) -> Duration {
    (interval / 2).clamp(Duration::from_secs(1), MAX_TICK)
}

/// Pure: whether a look at the clock at `now` (wall, ms) owes a pull.
/// `last_look` is the previous look, `next_due` when the cadence wants the
/// next pull, `last_pulled` the last pull that went through.
pub(crate) fn due(
    now: i64,
    last_look: i64,
    next_due: i64,
    interval: Duration,
    last_pulled: Option<i64>,
    first: bool,
) -> Option<Trigger> {
    let interval_ms = interval.as_millis() as i64;
    let woke = now - last_look > 2 * interval_ms;
    if woke && last_pulled.is_none_or(|at| now - at >= interval_ms) {
        return Some(Trigger::Wake);
    }
    (now >= next_due).then_some(if first { Trigger::Startup } else { Trigger::Timer })
}

fn run(app: AppHandle) {
    let started = now_ms();
    let mut last_look = started;
    let mut next_due = started + STARTUP_DELAY.as_millis() as i64;
    let mut first = true;
    let mut cadence = interval();
    loop {
        let interval = interval();
        if interval != cadence {
            // (Challenger) A walk shortened the cadence: it holds from now,
            // not after the pull the old one had scheduled.
            next_due = next_due.min(now_ms() + interval.as_millis() as i64);
            cadence = interval;
        }
        let asked = {
            let q = queue();
            let mut asked = q.asked.lock();
            if asked.is_none() && !stopping() {
                q.wake.wait_for(&mut asked, sleep_for(now_ms(), next_due, interval));
            }
            asked.take()
        };
        if stopping() {
            return;
        }
        let now = now_ms();
        if now < last_look {
            // The clock went back: start the cadence again from here.
            next_due = now + interval.as_millis() as i64;
        }
        let trigger = asked.or_else(|| {
            let last_pulled = current_record(&app).and_then(|lib| lib.last_pull_at);
            due(now, last_look, next_due, interval, last_pulled, first)
        });
        last_look = now;
        let Some(trigger) = trigger else { continue };
        first = false;
        let _ = team_pull(&app, trigger);
        // Skills hub H10 (R6): My library is pulled on the same cadence, as
        // its own account, after the team's. A team write's pull is the
        // team's alone.
        if matches!(trigger, Trigger::Startup | Trigger::Timer | Trigger::Wake) && !stopping() {
            let _ = crate::my_library::pull(&app);
        }
        let after = now_ms();
        last_look = after;
        next_due = after + interval.as_millis() as i64 + jitter_ms(interval);
    }
}

// ── One pull at a time ──────────────────────────────────────────────

/// One run at a time: a second caller while one runs waits for it and takes
/// its answer instead of running again.
pub(crate) struct Flight<T> {
    state: parking_lot::Mutex<FlightState<T>>,
    landed: parking_lot::Condvar,
}

struct FlightState<T> {
    running: bool,
    landed: u64,
    last: Option<T>,
}

impl<T: Clone> Flight<T> {
    pub(crate) const fn new() -> Self {
        Self {
            state: parking_lot::Mutex::new(FlightState {
                running: false,
                landed: 0,
                last: None,
            }),
            landed: parking_lot::Condvar::new(),
        }
    }

    /// Run `run`, or wait for the run under way and take its answer. A
    /// waiter that `retry_on_none` and finds the run answered `None` (a
    /// background pull that held back) runs its own.
    pub(crate) fn run(&self, retry_on_none: bool, run: impl FnOnce() -> Option<T>) -> Option<T> {
        {
            let mut f = self.state.lock();
            while f.running {
                let ticket = f.landed;
                while f.running && f.landed == ticket {
                    self.landed.wait(&mut f);
                }
                if f.last.is_some() || !retry_on_none {
                    return f.last.clone();
                }
            }
            f.running = true;
        }
        // Lands even if `run` panics, so nobody waits for ever.
        struct Landing<'a, T>(&'a Flight<T>, Option<T>);
        impl<T> Drop for Landing<'_, T> {
            fn drop(&mut self) {
                let mut f = self.0.state.lock();
                f.running = false;
                f.landed += 1;
                f.last = self.1.take();
                self.0.landed.notify_all();
            }
        }
        let mut landing = Landing(self, None);
        let out = run();
        landing.1 = out.clone();
        out
    }
}

static TEAM_PULL: Flight<TeamStatus> = Flight::new();

/// Pull the team library (or wait for the pull already running and take its
/// answer), record what it did, and say so. `None` when there was nothing to
/// pull: no team, a background pull the gate or the member's switch holds
/// back, or the app is quitting. Runs on the calling (blocking) thread.
pub(crate) fn team_pull(app: &AppHandle, trigger: Trigger) -> Option<TeamStatus> {
    if stopping() {
        return None;
    }
    TEAM_PULL.run(!trigger.background(), || pull_team_with(app, trigger))
}

/// The per-machine directory every Skills hub file lives under
/// (`skills_hub/state.json`, `skills_hub/bases/`): the one the app's stores
/// were opened on. Never `app_config_dir()` straight: a test's mock app has
/// no identifier, so that resolves to the user's real `Application Support`
/// folder itself (H4 Challenger). Tests without a `WorkspaceStore` get no
/// directory at all rather than the real one.
pub(crate) fn config_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    if let Some(store) = app.try_state::<crate::workspace::WorkspaceStore>() {
        return Ok(store.config_dir.clone());
    }
    #[cfg(test)]
    {
        let _ = app;
        Err("this test app has no WorkspaceStore, so it has no Skills hub directory".to_string())
    }
    #[cfg(not(test))]
    app.path()
        .app_config_dir()
        .map_err(|error| format!("resolve Plyloft config directory: {error}"))
}

/// The record of the team this Mac is in, if any.
fn current_record(app: &AppHandle) -> Option<LibraryState> {
    let slug = crate::commands::current_team_repo(app)?;
    let config_dir = config_dir(app).ok()?;
    crate::skills_hub_state::load(&config_dir)
        .libraries
        .get(&team_key(&slug))
        .cloned()
}

/// Whether sessions get this library on this Mac: not after the member
/// switched it off (R16), nor after this Mac left the team (R17).
pub(crate) fn delivers(config_dir: &Path, slug: &str) -> bool {
    crate::skills_hub_state::load(config_dir)
        .libraries
        .get(&team_key(slug))
        .is_none_or(|lib| !lib.switched_off && lib.left_at.is_none())
}

fn head_of(clone: &Path) -> Option<String> {
    if !clone.join(".git").exists() {
        return None;
    }
    crate::team::library_git_capture(clone, &["rev-parse", "--verify", "-q", "HEAD"])
        .ok()
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
}

pub(crate) fn pull_team_with(app: &AppHandle, trigger: Trigger) -> Option<TeamStatus> {
    let slug = crate::commands::current_team_repo(app)?;
    let config_dir = config_dir(app).ok()?;
    let key = team_key(&slug);
    let record = crate::skills_hub_state::load(&config_dir)
        .libraries
        .get(&key)
        .cloned()
        .unwrap_or_default();
    let team = app.state::<crate::team::TeamStore>();
    let clone = team.clone_dir(&slug);
    if trigger.background() {
        let gate = app
            .try_state::<crate::license::LicenseStore>()
            .and_then(|license| license.team_access().refusal());
        // R1 edges: no background pull on a plan without the team, after the
        // member switched the library off or this Mac left the team, nor into
        // a clone that waits on the member (a divergence, an operation under
        // way) — the member's own Refresh still can.
        let skipped = if gate.is_some() {
            Some("the plan has no team")
        } else if record.switched_off {
            Some("switched off on this machine")
        } else if record.left_at.is_some() {
            Some("this machine left the team")
        } else if crate::team::library_divergence(&clone).is_some() {
            Some("the clone has diverged")
        } else if crate::team::library_interruption(&clone).is_some() {
            Some("an operation is under way in the clone")
        } else {
            None
        };
        if let Some(why) = skipped {
            // Walk of H2: a skipped pull said nothing, so a walk couldn't
            // tell a gate from a scheduler that never ran.
            log::info!("skills hub: background pull of {slug} skipped ({why})");
            return None;
        }
    }
    if record.switched_off {
        // Switched off on this Mac: the page reads the clone (if it is still
        // there) and asks GitHub nothing until *Switch it back on*.
        return Some(crate::commands::team_status_blocking(app, false));
    }
    if asks_before_cloning(&record, clone.join(".git").exists()) {
        // Windows walk of H2: an ex-member whose clone already left. A read
        // (Settings › Team opening) used to clone the whole library again
        // only to find they still aren't listed, then remove that copy. One
        // file is enough to ask; only a member listed again clones.
        if let Some(status) = still_left(app, &slug, &config_dir, &key) {
            return Some(status);
        }
    }

    let before = head_of(&clone);
    let synced = {
        // N14 (OB-7b): the pull runs as the team's account.
        let _account = crate::commands::team_account_scope(app);
        // (Challenger) The switch is read again once the clone's lock is
        // held: switched off while this pull waited behind it, the clone is
        // in the Trash and must not be cloned straight back.
        team.sync_unless(&slug, || switched_off_now(&config_dir, &key))
    };
    let Some(synced) = synced else {
        return Some(crate::commands::team_status_blocking(app, false));
    };
    if stopping() {
        // (Challenger, Hard rule 4) Quitting: the pull was killed with the
        // other bounded children. Ask GitHub nothing more, record nothing (it
        // was not offline), move nothing to the Trash.
        return None;
    }
    let after = head_of(&clone);
    let cloned_now = matches!(&synced, Ok(outcome) if outcome.cloned);
    let attempt = classify_sync(&synced);
    let status = crate::commands::team_status_blocking_after_sync(app, true, Some(synced));
    // (Challenger) GitHub answered, but a clone that waits on the member (an
    // unpublished commit, an operation under way) was not brought level:
    // not "Updated just now".
    let attempt = held_by_the_clone(attempt, &status);
    let now = now_ms();
    let verdict = Verdict::of(&status, attempt);
    let effects = crate::skills_hub_state::update(&config_dir, now, |state| {
        let lib = state.libraries.entry(key.clone()).or_default();
        record_attempt(lib, &verdict, after.as_deref(), status.team_name.as_deref(), now)
    })
    .unwrap_or_else(|error| {
        log::warn!("skills hub: couldn't record the pull: {error}");
        Effects::default()
    });
    if verdict.attempt != Attempt::Pulled {
        // Walk of H2: a pull that failed left only state.json to tell.
        log::info!(
            "skills hub: pull of {slug} ({trigger:?}) did not update: {:?}, {:?}",
            verdict.attempt,
            verdict.membership
        );
    }

    let mut status = status;
    if effects.left {
        // (Challenger) Under the clone's lock, so it never goes from under a
        // team write; and deleted outright only when this read cloned it and
        // nothing was committed or changed in it since.
        if let Some(kept) = record.clone_kept.as_deref() {
            // Windows walk of H2: a later read retrying the move said nothing.
            log::info!("skills hub: trying again to move the team clone that stayed after leaving ({kept})");
        }
        let kept = {
            let _git = team.git_guard();
            // Deleted outright only when this very read cloned it (and it
            // holds nothing local); a clone that stayed is never deleted.
            remove_clone(&clone, if cloned_now { after.as_deref() } else { None })
        };
        if let Err(error) = crate::skills_hub_state::update(&config_dir, now, |state| {
            if let Some(lib) = state.libraries.get_mut(&key) {
                lib.clone_kept = kept.clone();
            }
        }) {
            log::warn!("skills hub: couldn't record the clone removal: {error}");
        }
        status = crate::commands::team_status_blocking(app, false);
    }

    if verdict.attempt == Attempt::Pulled && !effects.left {
        settle_proposals(app, &config_dir, &key, &clone, &slug, now);
    }

    if verdict.attempt == Attempt::Pulled && !effects.left {
        if let (Some(before), Some(after)) = (before.as_deref(), after.as_deref()) {
            if before != after {
                let own = verdict.login.clone().or(effects.member_login.clone());
                // (Challenger) Plyloft falls back to the git identity when it
                // can't read the login: that one is the member's too.
                let own_email = crate::team::library_git_capture(&clone, &["config", "user.email"])
                    .ok()
                    .map(|email| email.trim().to_string())
                    .filter(|email| !email.is_empty());
                match changed_skills(&clone, before, after, own.as_deref(), own_email.as_deref()) {
                    Ok(changes) if !changes.is_empty() => {
                        let _ = app.emit(
                            PULLED_EVENT,
                            PulledPayload {
                                library: key.clone(),
                                team_name: status.team_name.clone(),
                                changes,
                            },
                        );
                    }
                    Ok(_) => {}
                    Err(error) => log::warn!("skills hub: couldn't read what the pull changed: {error}"),
                }
            }
        }
    }
    let _ = app.emit(LIBRARY_EVENT, ());
    // H6a: a pull may have brought a script that needs an OK; H2: access lost
    // or back. The Inbox reads its rows again.
    let _ = app.emit(DECISION_EVENT, ());
    Some(status)
}

/// Skills hub H4 (Challenger): after a pull, forget this Mac's proposals
/// whose pull request GitHub no longer has open (merged, or closed without
/// merging), so no row keeps *Proposed upstream* for a pull request that is
/// gone and the Inbox asks again. One `gh` read per standing proposal, as
/// the team's account; nothing is asked when there is none.
fn settle_proposals(app: &AppHandle, config_dir: &Path, key: &str, clone: &Path, slug: &str, now: i64) {
    let state = crate::skills_hub_state::load(config_dir);
    let prefix = format!("{key}/");
    if !state.proposals.keys().any(|k| k.starts_with(&prefix)) {
        return;
    }
    let Ok(gh) = crate::doctor::require("gh").map(crate::shared_config::Gh::new) else {
        return;
    };
    let answers = {
        let _account = crate::commands::team_account_scope(app);
        crate::commands::skills_hub_decisions::proposal_answers(&state, key, clone, slug, &gh)
    };
    if answers.is_empty() {
        return;
    }
    if let Err(error) = crate::skills_hub_state::update(config_dir, now, |state| {
        let gone = crate::commands::skills_hub_decisions::settle_proposals(state, key, &answers);
        if !gone.is_empty() {
            log::info!("skills hub: {} proposal(s) no longer open on GitHub, forgotten", gone.len());
        }
    }) {
        log::warn!("skills hub: couldn't record which proposals are still open: {error}");
    }
}

/// Whether sessions get the library: re-read under the clone's lock.
fn switched_off_now(config_dir: &Path, key: &str) -> bool {
    crate::skills_hub_state::load(config_dir)
        .libraries
        .get(key)
        .is_some_and(|lib| lib.switched_off)
}

/// Windows walk of H2: a read asks GitHub for `team.json` alone, before any
/// clone, when this Mac left the team and its clone is already gone.
pub(crate) fn asks_before_cloning(record: &LibraryState, has_clone: bool) -> bool {
    record.left_at.is_some() && !has_clone
}

/// The membership answer for an ex-member with no clone, from `team.json`
/// read through the API (`fetch`) and GitHub's login and access (`probe`).
/// GitHub unreachable for the file: no answer, and the probe is not run.
pub(crate) fn left_member_probe(
    fetch: impl FnOnce() -> Result<Option<String>, String>,
    probe: impl FnOnce(Option<&crate::team::TeamManifest>) -> crate::team::MembershipProbe,
) -> crate::team::MembershipProbe {
    match fetch() {
        Ok(text) => {
            let mut errors = Vec::new();
            let manifest = text.and_then(|text| match crate::team::parse_manifest(text.as_bytes()) {
                Ok(manifest) => Some(manifest),
                Err(error) => {
                    errors.push(format!("Could not read the team manifest: {error}"));
                    None
                }
            });
            let mut answer = probe(manifest.as_ref());
            answer.errors.extend(errors);
            answer
        }
        Err(error) => crate::team::MembershipProbe {
            membership: Membership::Unknown,
            login: None,
            can_write: None,
            errors: vec![format!("Could not read the team manifest from GitHub: {error}")],
        },
    }
}

/// An ex-member's read with no clone ([`asks_before_cloning`]): `None` when
/// the manifest lists this account again (the caller clones; it is back),
/// otherwise the page's status, recorded like a pull and with nothing cloned.
fn still_left(app: &AppHandle, slug: &str, config_dir: &Path, key: &str) -> Option<TeamStatus> {
    let team = app.state::<crate::team::TeamStore>();
    let probe = {
        // N14 (OB-7b): as the team's account, like the pull.
        let _account = crate::commands::team_account_scope(app);
        left_member_probe(
            || crate::github::repo_file_text(slug, crate::team::MANIFEST_FILE),
            |manifest| crate::team::probe_membership(slug, manifest),
        )
    };
    if stopping() {
        // (Hard rule 4) Quitting: the gh call was killed. Record nothing (it
        // was not offline) and clone nothing.
        return Some(crate::commands::team_status_blocking(app, false));
    }
    if probe.membership == Membership::Member {
        log::info!("skills hub: {slug} lists this machine's account again; cloning its library");
        return None;
    }
    team.remember_membership(slug, probe.membership, probe.login.clone(), probe.can_write);
    let now = now_ms();
    let verdict = Verdict {
        attempt: Attempt::NotPulled,
        membership: probe.membership,
        login: probe.login.clone(),
    };
    if let Err(error) = crate::skills_hub_state::update(config_dir, now, |state| {
        let lib = state.libraries.entry(key.to_string()).or_default();
        record_attempt(lib, &verdict, None, None, now);
    }) {
        log::warn!("skills hub: couldn't record the read: {error}");
    }
    log::info!(
        "skills hub: {slug}: this machine is still not in the team ({:?}); read team.json from GitHub, cloned nothing",
        probe.membership
    );
    let mut status = crate::commands::team_status_blocking(app, false);
    if probe.membership != Membership::Unknown {
        status.membership = probe.membership;
        status.membership_reason = probe.membership.reason().map(str::to_string);
        status.login = probe.login.clone();
        status.membership_stale = false;
    }
    if !probe.errors.is_empty() {
        status.error = Some(probe.errors.join(" "));
    }
    let _ = app.emit(LIBRARY_EVENT, ());
    let _ = app.emit(DECISION_EVENT, ());
    Some(status)
}

/// (Challenger) A pull GitHub answered that left the clone where it was,
/// because the clone waits on the member: [`Attempt::Held`].
fn held_by_the_clone(attempt: Attempt, status: &TeamStatus) -> Attempt {
    if attempt == Attempt::Pulled
        && (status.library_divergence.is_some() || status.library_interruption.is_some())
    {
        Attempt::Held
    } else {
        attempt
    }
}

/// (Challenger) A clone that may be deleted outright rather than moved to the
/// Trash: the one this same read cloned (`fresh_head`, its `HEAD` right
/// after), still at that commit with nothing changed or added in it — it
/// holds nothing of the member's. Anything else, or a git that can't say,
/// is not.
pub(crate) fn holds_nothing_local(clone: &Path, fresh_head: Option<&str>) -> bool {
    let Some(fresh_head) = fresh_head else { return false };
    if head_of(clone).as_deref() != Some(fresh_head) {
        return false;
    }
    crate::team::library_git_capture(clone, &["status", "--porcelain", "--untracked-files=all"])
        .is_ok_and(|out| out.trim().is_empty())
}

/// R17: the team library leaves this Mac. A clone this same read cloned that
/// holds nothing of the member's ([`holds_nothing_local`]) is deleted; any
/// other — the member's unpublished commits and edits included — goes to the
/// Trash / Recycle Bin (Put Back works). `Some(reason)` when it stayed.
pub(crate) fn remove_clone(clone: &Path, fresh_head: Option<&str>) -> Option<String> {
    if !clone.exists() {
        return None;
    }
    if holds_nothing_local(clone, fresh_head) {
        match std::fs::remove_dir_all(clone) {
            Ok(()) => {
                log::info!(
                    "skills hub: deleted the team clone {} (cloned by this read, nothing local in it)",
                    clone.display()
                );
                return None;
            }
            // Windows: a read-only pack, a file a process holds. What is left
            // goes to the Recycle Bin below.
            Err(error) => log::warn!("skills hub: couldn't delete the fresh team clone ({error}); trashing it"),
        }
    }
    match crate::trash::trash_all(&[clone.to_path_buf()]) {
        Ok(landed) => {
            // Windows walk of H2: the move said nothing when it went through.
            log::info!(
                "skills hub: moved the team clone {} to {}{}",
                clone.display(),
                crate::trash::BIN,
                landed
                    .first()
                    .map(|at| format!(" ({})", at.display()))
                    .unwrap_or_default()
            );
            None
        }
        Err(refusal) => {
            log::warn!("skills hub: the team clone stays: {}", refusal.reason);
            Some(refusal.reason)
        }
    }
}

// ── What one attempt was ────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Attempt {
    /// The pull (or the first clone) went through.
    Pulled,
    /// (Challenger) GitHub answered, but the clone stayed where it was: it
    /// holds an unpublished commit (GH #226) or an operation under way.
    /// Access is fine; the library is not level.
    Held,
    /// It did not.
    NotPulled,
}

pub(crate) fn classify_sync(synced: &Result<SyncOutcome, String>) -> Attempt {
    match synced {
        Ok(outcome) if outcome.pull_error.is_none() => Attempt::Pulled,
        _ => Attempt::NotPulled,
    }
}

/// One attempt and GitHub's answer about this account, as the record needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Verdict {
    pub attempt: Attempt,
    /// GitHub's answer *now*; `Unknown` when it couldn't be asked (a stale
    /// answer carried from before is not one).
    pub membership: Membership,
    pub login: Option<String>,
}

impl Verdict {
    pub(crate) fn of(status: &TeamStatus, attempt: Attempt) -> Self {
        Self {
            attempt,
            membership: if status.membership_stale {
                Membership::Unknown
            } else {
                status.membership
            },
            login: (!status.membership_stale).then(|| status.login.clone()).flatten(),
        }
    }
}

/// What [`record_attempt`] decided beyond the record itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Effects {
    /// R17: this Mac is not in the team any more; its clone goes.
    pub left: bool,
    /// R16: access was just declared lost (the Inbox row appears).
    pub access_lost: bool,
    pub member_login: Option<String>,
}

fn same_login(a: Option<&str>, b: Option<&str>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if a.trim().eq_ignore_ascii_case(b.trim()))
}

/// Pure: fold one attempt into a library's record.
pub(crate) fn record_attempt(
    lib: &mut LibraryState,
    verdict: &Verdict,
    head: Option<&str>,
    team_name: Option<&str>,
    now: i64,
) -> Effects {
    let mut effects = Effects::default();
    lib.last_attempt_at = Some(now);
    if let Some(name) = team_name.filter(|n| !n.trim().is_empty()) {
        lib.team_name = Some(name.to_string());
    }
    let about_the_member = same_login(verdict.login.as_deref(), lib.member_login.as_deref());
    match verdict.attempt {
        Attempt::Pulled => {
            lib.last_pull_at = Some(now);
            lib.last_pull_commit = head.map(str::to_string);
            lib.last_error = None;
            lib.failures = 0;
            lib.first_failure_at = None;
            lib.access_lost = None;
            lib.kept_last_copy = false;
        }
        Attempt::Held => {
            // GitHub let this account read it: no refusal run, no question.
            // But nothing new arrived, so "Updated …" keeps its time.
            lib.last_error = Some("held".into());
            lib.failures = 0;
            lib.first_failure_at = None;
            lib.access_lost = None;
            lib.kept_last_copy = false;
        }
        Attempt::NotPulled => match verdict.membership {
            Membership::NoRepoAccess => {
                lib.last_error = Some("noAccess".into());
                if about_the_member {
                    lib.failures += 1;
                    let first = *lib.first_failure_at.get_or_insert(now);
                    if lib.failures >= ACCESS_LOST_AFTER
                        && now - first >= ACCESS_LOST_SPAN_MS
                        && lib.access_lost.is_none()
                    {
                        lib.access_lost = Some(now);
                        effects.access_lost = true;
                    }
                }
            }
            Membership::Unknown => lib.last_error = Some("offline".into()),
            Membership::Member | Membership::NotListed => lib.last_error = Some("failed".into()),
        },
    }
    match verdict.membership {
        Membership::Member => {
            lib.member_login = verdict.login.clone().or(lib.member_login.take());
            lib.left_at = None;
            lib.clone_kept = None;
        }
        // R17: only an account that was a member here, now not listed. Every
        // such answer removes the clone again (a read of the team after
        // leaving clones it to ask); `left_at` keeps the first time.
        Membership::NotListed if about_the_member => {
            lib.left_at.get_or_insert(now);
            effects.left = true;
        }
        _ => {}
    }
    effects.member_login = lib.member_login.clone();
    effects
}

// ── What a pull changed ─────────────────────────────────────────────

/// One skill a pull changed, and who changed it (newest first).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillChange {
    pub skill: String,
    pub authors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PulledPayload {
    library: String,
    team_name: Option<String>,
    changes: Vec<SkillChange>,
}

/// The skill a library path belongs to: `library/claude/<plugin>/skills/<name>/…`
/// or `library/codex/plugins/<plugin>/skills/<name>/…`. The two CLIs' copies
/// are one skill.
pub(crate) fn skill_of(path: &str) -> Option<&str> {
    let parts: Vec<&str> = path.split('/').collect();
    match parts.as_slice() {
        ["library", "claude", _plugin, "skills", name, _, ..] => Some(name),
        ["library", "codex", "plugins", _plugin, "skills", name, _, ..] => Some(name),
        _ => None,
    }
}

/// Whether a commit's author is the member (their own push, from another
/// Mac): Plyloft commits as the GitHub login with its noreply address.
fn is_own(name: &str, email: &str, login: Option<&str>) -> bool {
    let Some(login) = login.map(str::trim).filter(|l| !l.is_empty()) else {
        return false;
    };
    let email = email.trim().to_ascii_lowercase();
    let login_lc = login.to_ascii_lowercase();
    name.trim().eq_ignore_ascii_case(login)
        || email == format!("{login_lc}@users.noreply.github.com")
        || email.ends_with(&format!("+{login_lc}@users.noreply.github.com"))
}

const RECORD: char = '\u{1e}';
const FIELD: char = '\u{1f}';

/// Pure: `git log --format=%x1e%an%x1f%ae --name-only` output → the skills
/// changed by someone other than `own_login`, in order of their newest change.
pub(crate) fn parse_changes(log: &str, own_login: Option<&str>) -> Vec<SkillChange> {
    parse_changes_by_others(log, own_login, None)
}

/// [`parse_changes`], also leaving out commits authored with `own_email` (the
/// git identity Plyloft commits with when it can't read the login).
pub(crate) fn parse_changes_by_others(
    log: &str,
    own_login: Option<&str>,
    own_email: Option<&str>,
) -> Vec<SkillChange> {
    let own_email = own_email.map(str::trim).filter(|e| !e.is_empty());
    let mut out: Vec<SkillChange> = Vec::new();
    for record in log.split(RECORD).filter(|r| !r.trim().is_empty()) {
        let mut lines = record.lines();
        let Some(header) = lines.next() else { continue };
        let (name, email) = header.split_once(FIELD).unwrap_or((header, ""));
        if is_own(name, email, own_login)
            || own_email.is_some_and(|own| email.trim().eq_ignore_ascii_case(own))
        {
            continue;
        }
        let author = name.trim().to_string();
        for path in lines.map(str::trim).filter(|l| !l.is_empty()) {
            let Some(skill) = skill_of(path) else { continue };
            match out.iter_mut().find(|c| c.skill == skill) {
                Some(change) => {
                    if !author.is_empty() && !change.authors.contains(&author) {
                        change.authors.push(author.clone());
                    }
                }
                None => out.push(SkillChange {
                    skill: skill.to_string(),
                    authors: if author.is_empty() { Vec::new() } else { vec![author.clone()] },
                }),
            }
        }
    }
    out
}

/// What `before..after` changed in the library's skills, by someone else.
pub(crate) fn changed_skills(
    clone: &Path,
    before: &str,
    after: &str,
    own_login: Option<&str>,
    own_email: Option<&str>,
) -> Result<Vec<SkillChange>, String> {
    let range = format!("{before}..{after}");
    let log = crate::team::library_git_capture(
        clone,
        &[
            "log",
            "--no-renames",
            "--name-only",
            "--format=%x1e%an%x1f%ae",
            &range,
            "--",
            "library/claude",
            "library/codex",
        ],
    )?;
    Ok(parse_changes_by_others(&log, own_login, own_email))
}

// ── What the pages show ─────────────────────────────────────────────

/// The team library's pull record, for "Updated 4 min ago", the access-lost
/// notice and "You're no longer in … team".
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryPullView {
    pub library: String,
    pub repo: String,
    pub team_name: Option<String>,
    pub has_clone: bool,
    pub last_pull_at: Option<i64>,
    /// The commit the last pull brought: the Library's team section reads
    /// its rows again when it moves (Windows walk of H2).
    pub last_pull_commit: Option<String>,
    pub last_attempt_at: Option<i64>,
    /// `"offline"` · `"noAccess"` · `"failed"`.
    pub last_error: Option<String>,
    /// Why no background pull runs: `"plan"` (the team gate refuses).
    pub held_back: Option<String>,
    pub switched_off: bool,
    pub access_lost: Option<i64>,
    pub kept_last_copy: bool,
    pub left_at: Option<i64>,
    /// Why the clone stayed on this Mac after leaving (no Recycle Bin…).
    pub clone_kept: Option<String>,
    /// The account GitHub last confirmed as a member here.
    pub login: Option<String>,
}

pub(crate) fn view(config_dir: &Path, slug: &str, has_clone: bool, gate_refusal: Option<&str>) -> LibraryPullView {
    let key = team_key(slug);
    let lib = crate::skills_hub_state::load(config_dir)
        .libraries
        .get(&key)
        .cloned()
        .unwrap_or_default();
    LibraryPullView {
        library: key,
        repo: slug.to_string(),
        team_name: lib.team_name,
        has_clone,
        last_pull_at: lib.last_pull_at,
        last_pull_commit: lib.last_pull_commit,
        last_attempt_at: lib.last_attempt_at,
        last_error: lib.last_error,
        held_back: gate_refusal.map(|_| "plan".to_string()),
        switched_off: lib.switched_off,
        access_lost: lib.access_lost,
        kept_last_copy: lib.kept_last_copy,
        left_at: lib.left_at,
        clone_kept: lib.clone_kept,
        login: lib.member_login,
    }
}

fn view_of(app: &AppHandle) -> Result<Option<LibraryPullView>, String> {
    let Some(slug) = crate::commands::current_team_repo(app) else {
        return Ok(None);
    };
    let config_dir = config_dir(app)?;
    let has_clone = app.state::<crate::team::TeamStore>().clone_dir(&slug).join(".git").exists();
    let gate = app
        .try_state::<crate::license::LicenseStore>()
        .and_then(|license| license.team_access().refusal());
    Ok(Some(view(&config_dir, &slug, has_clone, gate.as_deref())))
}

/// The team library's pull record on this Mac. Local: one small file.
#[tauri::command]
pub async fn skills_hub_library_status(app: AppHandle) -> Result<Option<LibraryPullView>, String> {
    tauri::async_runtime::spawn_blocking(move || view_of(&app))
        .await
        .map_err(|error| format!("join library status: {error}"))?
}

/// R16: *Switch it off on this Mac* (`on: false`) or *Switch it back on*.
///
/// Off: sessions from the next one get no team skills, nothing is pulled,
/// and — the team library being the team's — R17's cleanup runs: the clone
/// goes to the Trash / Recycle Bin. On: the record is cleared and the next
/// read of the team clones it again.
#[tauri::command]
pub async fn skills_hub_library_switch(app: AppHandle, on: bool) -> Result<Option<LibraryPullView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(slug) = crate::commands::current_team_repo(&app) else {
            return Ok(None);
        };
        let config_dir = config_dir(&app)?;
        let key = team_key(&slug);
        let now = now_ms();
        crate::skills_hub_state::update(&config_dir, now, |state| {
            let lib = state.libraries.entry(key.clone()).or_default();
            lib.switched_off = !on;
            if on {
                lib.access_lost = None;
                lib.kept_last_copy = false;
                lib.failures = 0;
                lib.first_failure_at = None;
                lib.left_at = None;
                lib.clone_kept = None;
            }
        })?;
        if !on {
            let team = app.state::<crate::team::TeamStore>();
            // Not while a pull writes into it.
            let _git = team.git_guard();
            let kept = remove_clone(&team.clone_dir(&slug), None);
            crate::skills_hub_state::update(&config_dir, now, |state| {
                if let Some(lib) = state.libraries.get_mut(&key) {
                    lib.clone_kept = kept;
                }
            })?;
        }
        let _ = app.emit(LIBRARY_EVENT, ());
        let _ = app.emit(DECISION_EVENT, ());
        view_of(&app)
    })
    .await
    .map_err(|error| format!("join library switch: {error}"))?
}

/// R16: *Keep the last copy*: the question goes; sessions keep the copy they
/// have, and Plyloft keeps trying in the background.
#[tauri::command]
pub async fn skills_hub_keep_last_copy(app: AppHandle) -> Result<Option<LibraryPullView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(slug) = crate::commands::current_team_repo(&app) else {
            return Ok(None);
        };
        let config_dir = config_dir(&app)?;
        crate::skills_hub_state::update(&config_dir, now_ms(), |state| {
            state.libraries.entry(team_key(&slug)).or_default().kept_last_copy = true;
        })?;
        let _ = app.emit(LIBRARY_EVENT, ());
        let _ = app.emit(DECISION_EVENT, ());
        view_of(&app)
    })
    .await
    .map_err(|error| format!("join keep last copy: {error}"))?
}

/// R16 (Inbox): the access-lost question for the team library whose clone is
/// `clone`, while it waits for the member's answer.
pub(crate) fn access_lost_question(config_dir: &Path, clone: &Path) -> Option<(String, LibraryState)> {
    let dir = clone.file_name()?.to_string_lossy().to_string();
    crate::skills_hub_state::load(config_dir)
        .libraries
        .into_iter()
        .find(|(key, lib)| {
            key.strip_prefix("team:")
                .is_some_and(|slug| crate::team::slug_dir_name(slug).eq_ignore_ascii_case(&dir))
                && lib.access_lost.is_some()
                && !lib.kept_last_copy
                && !lib.switched_off
        })
}

#[cfg(test)]
#[path = "skills_hub_tests.rs"]
mod tests;
