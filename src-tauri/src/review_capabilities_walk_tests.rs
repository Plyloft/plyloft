//! 1.176.1 walk (2026-11-22, steps 9 and 15): a Program folders setting that
//! finds no tool, then Repair adding `~/.local/bin` back, with Codex at the
//! same version throughout, re-ran the reviewer probe twice — once failing on
//! "Git isn't installed" (a warning toast, Diagnostics saying it had updated)
//! and once more at the next launch. A proof is keyed by what it was made
//! against; a look that can't see the tool says nothing about it; a probe
//! that can't run doesn't run, and one that stops on something not the
//! tool's fails nothing.

use super::*;
use std::cell::Cell;

fn env_with(path: Option<&str>, version: Option<&str>) -> ShellEnv {
    ShellEnv {
        claude_path: path.map(str::to_string),
        claude_version: version.map(str::to_string),
        git_path: Some("/usr/bin/git".into()),
        git_version: Some("git version test".into()),
        ..ShellEnv::default()
    }
}

fn proof(binary: &Path, version: &str) -> CapabilityRecord {
    CapabilityRecord {
        provider: Provider::Claude,
        executable_path: canonical_executable(binary.to_str().unwrap()),
        version: version.into(),
        level: Some(CapabilityLevel::HarnessEnforced),
        outcome: ProbeOutcome::Passed,
        proof: "proved".into(),
        probed_at: 1,
        profile: proof_profile(Provider::Claude).into(),
        ..CapabilityRecord::default()
    }
}

/// A passed proof for Claude 1.0.0 at a real file, and a link to that file.
fn proved() -> (tempfile::TempDir, ReviewerCapabilityRegistry, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let registry = ReviewerCapabilityRegistry::new(tmp.path().to_path_buf()).unwrap();
    let release = tmp.path().join("releases").join("1.0.0");
    fs::create_dir_all(&release).unwrap();
    let binary = release.join("claude");
    fs::write(&binary, "").unwrap();
    let bin = tmp.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let link = bin.join("claude");
    let linked = crate::platform::symlink(&binary, &link).is_ok();
    registry.upsert(proof(&binary, "1.0.0")).unwrap();
    (tmp, registry, binary, if linked { link } else { PathBuf::new() })
}

fn persisted(tmp: &Path) -> CapabilityState {
    serde_json::from_slice(&fs::read(tmp.join(STORE_RELATIVE_PATH)).unwrap()).unwrap()
}

#[test]
fn drift_is_a_different_real_file_or_version_and_never_an_unseen_tool() {
    let (_tmp, _registry, binary, link) = proved();
    let record = proof(&binary, "1.0.0");
    let real = canonical_executable(binary.to_str().unwrap());
    assert_eq!(drift(&record, None, Some("1.0.0")), Drift::Unknown, "vanished from the snapshot");
    assert_eq!(drift(&record, Some(&real), None), Drift::Unknown, "version unreadable");
    assert_eq!(drift(&record, None, None), Drift::Unknown);
    assert_eq!(drift(&record, Some(&real), Some("1.0.0")), Drift::Same);
    if !link.as_os_str().is_empty() {
        // Another spelling of the same file (the launcher link) is the same file.
        let through_link = canonical_executable(link.to_str().unwrap());
        assert_eq!(drift(&record, Some(&through_link), Some("1.0.0")), Drift::Same);
    }
    assert_eq!(drift(&record, Some(&real), Some("1.0.1")), Drift::Changed, "a real update");
    assert_eq!(drift(&record, Some("/elsewhere/claude"), Some("1.0.0")), Drift::Changed, "another binary");
    let older_contract = CapabilityRecord { profile: "some-older-contract".into(), ..record.clone() };
    assert_eq!(drift(&older_contract, Some(&real), Some("1.0.0")), Drift::Changed);
}

/// What the probe needs, and what it did.
struct Host {
    registry: ReviewerCapabilityRegistry,
    env: ShellEnv,
    missing: Option<String>,
    error: Option<String>,
    probes: Cell<u32>,
    started: Cell<u32>,
}

impl AutoProbeHost for Host {
    fn view(&self, provider: Provider) -> ReviewerCapabilityView {
        self.registry.current(provider, &self.env)
    }
    fn review_in_flight(&self, _: Provider) -> bool {
        false
    }
    fn online(&self, _: Provider) -> bool {
        true
    }
    fn probe(&self, _: Provider) -> Result<(), String> {
        self.probes.set(self.probes.get() + 1);
        match &self.error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
    fn pause(&self) {}
    fn starting(&self, _: &ProbeKey) {
        self.started.set(self.started.get() + 1);
    }
    fn ready(&self, _: Provider) -> Result<(), String> {
        self.missing.clone().map_or(Ok(()), Err)
    }
}

fn host(registry: &ReviewerCapabilityRegistry, env: ShellEnv) -> Host {
    Host { registry: registry.clone(), env, missing: None, error: None, probes: Cell::new(0), started: Cell::new(0) }
}

/// Steps 9 and 15: whole → no tools → tools back at the same version. Zero
/// requests, the proof unchanged, and the next launch the same.
#[test]
fn the_walks_program_folders_sequence_costs_no_request() {
    let (tmp, registry, binary, link) = proved();
    let back = if link.as_os_str().is_empty() { binary.clone() } else { link.clone() };
    let whole = env_with(binary.to_str(), Some("1.0.0"));
    let nothing = env_with(None, None);
    let again = env_with(back.to_str(), Some("1.0.0"));
    let before = persisted(tmp.path());
    let probes = Cell::new(0);
    for snapshot in [&whole, &nothing, &again] {
        registry.invalidate_drift(snapshot).unwrap();
        let view = registry.current(Provider::Claude, snapshot);
        if let Some(key) = registry.claim_auto_probe(&view) {
            probes.set(probes.get() + 1);
            registry.finish_auto_probe(&key, false);
        }
    }
    assert_eq!(probes.get(), 0, "no re-check is owed");
    assert_eq!(persisted(tmp.path()), before, "the proof is unchanged");
    let view = registry.current(Provider::Claude, &again);
    assert!(view.eligible && !view.stale, "{view:?}");
    let relaunched = ReviewerCapabilityRegistry::new(tmp.path().to_path_buf()).unwrap();
    relaunched.invalidate_drift(&again).unwrap();
    let view = relaunched.current(Provider::Claude, &again);
    assert!(view.eligible && auto_probe_key(&view).is_none(), "the next launch asks nothing: {view:?}");
}

/// A proof an earlier build marked stale for a tool it lost (1.176.0, and
/// the walk's own record) holds again for the same identity, without a
/// request, and the mark comes off on disk.
#[test]
fn a_proof_marked_stale_by_a_vanished_tool_holds_again_without_a_request() {
    let (tmp, registry, binary, _) = proved();
    registry.upsert(CapabilityRecord { stale: true, ..proof(&binary, "1.0.0") }).unwrap();
    let same = env_with(binary.to_str(), Some("1.0.0"));
    let view = registry.current(Provider::Claude, &same);
    assert!(view.eligible && !view.stale && auto_probe_key(&view).is_none(), "{view:?}");
    registry.invalidate_drift(&same).unwrap();
    assert!(!persisted(tmp.path()).records[0].stale);
    // A real update still drifts.
    let updated = env_with(binary.to_str(), Some("1.0.1"));
    registry.invalidate_drift(&updated).unwrap();
    assert!(persisted(tmp.path()).records[0].stale);
    assert!(auto_probe_key(&registry.current(Provider::Claude, &updated)).is_some());
}

/// A re-check owed by a real update, on a snapshot without git: nothing
/// starts, nothing is recorded, nothing is said; once git is back it runs.
#[test]
fn a_re_check_waits_for_what_it_needs() {
    let (tmp, registry, binary, _) = proved();
    let updated = env_with(binary.to_str(), Some("1.0.1"));
    let mut host = host(&registry, updated.clone());
    host.missing = Some("Git isn't installed, or isn't on Plyloft's PATH.".into());
    let before = persisted(tmp.path());
    let key = registry.claim_auto_probe(&host.view(Provider::Claude)).unwrap();
    let outcome = run_auto_probe(&registry, &host, &key);
    assert!(matches!(outcome, AutoProbeOutcome::NotReady(_)), "{outcome:?}");
    assert_eq!((host.probes.get(), host.started.get()), (0, 0), "no request, no notice");
    assert_eq!(persisted(tmp.path()), before, "nothing recorded");
    let event = auto_probe_event(&key, outcome);
    assert_eq!(event.result, AutoProbeResult::Skipped, "no warning");
    assert!(event.detail.starts_with("Plyloft couldn't check this yet"), "{}", event.detail);
    // Given back: once the snapshot is whole a later resolve runs it.
    registry.expire_auto_probe_retries();
    host.missing = None;
    let key = registry.claim_auto_probe(&host.view(Provider::Claude)).unwrap();
    run_auto_probe(&registry, &host, &key);
    assert_eq!((host.probes.get(), host.started.get()), (1, 1));
}

/// A probe that stopped on something not the tool's answer fails no proof
/// and warns nobody; Claude's folder trust still asks the person.
#[test]
fn a_probe_that_stopped_on_something_else_fails_nothing() {
    let (tmp, registry, binary, _) = proved();
    let updated = env_with(binary.to_str(), Some("1.0.1"));
    let mut host = host(&registry, updated);
    host.error = Some("Git isn't installed, or isn't on Plyloft's PATH.".into());
    let before = persisted(tmp.path());
    let key = registry.claim_auto_probe(&host.view(Provider::Claude)).unwrap();
    let outcome = run_auto_probe(&registry, &host, &key);
    assert!(matches!(outcome, AutoProbeOutcome::NotChecked(_)), "{outcome:?}");
    assert_eq!(persisted(tmp.path()), before, "no failure, no auto-retried mark");
    assert_eq!(auto_probe_event(&key, outcome).result, AutoProbeResult::Skipped);
    // Held for this launch (it may have made a request): not again now.
    assert!(registry.claim_auto_probe(&host.view(Provider::Claude)).is_none());
    let relaunched = ReviewerCapabilityRegistry::new(tmp.path().to_path_buf()).unwrap();
    let key = relaunched.claim_auto_probe(&relaunched.current(Provider::Claude, &host.env));
    let key = key.expect("the next launch tries again");

    // On that launch, Claude's folder trust still asks the person.
    host.error = Some(crate::claude_session::FOLDER_TRUST_REFUSAL.into());
    let trust = Host { registry: relaunched.clone(), ..host };
    let outcome = run_auto_probe(&relaunched, &trust, &key);
    assert!(matches!(outcome, AutoProbeOutcome::Failed { error: Some(_), .. }), "{outcome:?}");
}
