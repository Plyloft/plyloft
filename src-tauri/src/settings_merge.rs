//! 1.176.2 R2: a save from the window applies only what the window changed.
//!
//! `settings.json` is one file, written by the backend (Program folders from
//! Repair, the ignored team repositories, "Not on this Mac", the git email)
//! and by the window, which keeps its own copy of the whole settings and sent
//! all of it on every save. A window save built on a copy from before a
//! backend change put the old value back. Now the window sends the copy its
//! change was based on (`base`) beside the new value (`next`), and the store
//! merges the two onto what it holds (`stored`), under its lock
//! ([`crate::settings::SettingsStore::replace_from`]).
//!
//! The merge works on the JSON tree, key by key, with no list of fields: a
//! setting added later is merged like every other one. Arrays and scalars are
//! whole values.

use serde_json::Value;

/// Three-way merge of the window's save onto what is stored.
///
/// - A key whose value the window left as it was in `base` keeps the stored
///   value (or stays absent, when the stored settings don't have it).
/// - A key the window changed takes the window's value. When the stored value
///   changed too, the window still wins: the person just set it. Where both
///   sides hold objects, the merge goes one level down, so only the leaves
///   the window changed are taken.
/// - A key the window added is taken; a key the window removed (in `base`,
///   not in `next`) is removed.
/// - Keys only the stored side has are kept.
pub fn merge3(stored: &Value, base: &Value, next: &Value) -> Value {
    let (Value::Object(stored_map), Value::Object(base_map), Value::Object(next_map)) = (stored, base, next) else {
        // Arrays and scalars are whole values: the window's when it changed
        // it, the stored one otherwise.
        return if base == next { stored.clone() } else { next.clone() };
    };
    let mut out = stored_map.clone();
    for (key, next_value) in next_map {
        match base_map.get(key) {
            Some(base_value) if base_value == next_value => {}
            Some(base_value) => {
                let merged = match stored_map.get(key) {
                    Some(stored_value) => merge3(stored_value, base_value, next_value),
                    None => next_value.clone(),
                };
                out.insert(key.clone(), merged);
            }
            None => {
                out.insert(key.clone(), next_value.clone());
            }
        }
    }
    for key in base_map.keys() {
        if !next_map.contains_key(key) {
            out.remove(key);
        }
    }
    Value::Object(out)
}

/// [`merge3`] over the settings themselves. `base` and `next` both come from
/// the window and are read through the same `Settings` shape, so a field the
/// window doesn't carry (a backend-owned one) reads the same default on both
/// sides and keeps what is stored.
pub fn merge_settings(
    stored: &crate::settings::Settings,
    base: &crate::settings::Settings,
    next: &crate::settings::Settings,
) -> Result<crate::settings::Settings, String> {
    let encode = |s: &crate::settings::Settings| serde_json::to_value(s).map_err(|e| format!("encode: {e}"));
    let merged = merge3(&encode(stored)?, &encode(base)?, &encode(next)?);
    serde_json::from_value(merged).map_err(|e| format!("decode: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Settings, SettingsStore, ThemePref};
    use serde_json::json;

    // ---- The pure merge, on JSON trees no list of fields knows ----

    #[test]
    fn a_backend_change_survives_a_window_save_built_on_the_old_copy() {
        let base = json!({ "shell": { "pathOverride": null }, "appearance": { "theme": "light" } });
        // The backend wrote Program folders after the window read `base`.
        let stored = json!({ "shell": { "pathOverride": "/opt/x" }, "appearance": { "theme": "light" } });
        // The window changes only the theme, on its old copy.
        let next = json!({ "shell": { "pathOverride": null }, "appearance": { "theme": "dark" } });
        assert_eq!(
            merge3(&stored, &base, &next),
            json!({ "shell": { "pathOverride": "/opt/x" }, "appearance": { "theme": "dark" } })
        );
    }

    #[test]
    fn both_changed_the_same_field_and_the_window_wins() {
        // The person just typed this value: it is the one kept.
        let base = json!({ "shell": { "pathOverride": "/a" } });
        let stored = json!({ "shell": { "pathOverride": "/backend" } });
        let next = json!({ "shell": { "pathOverride": "/typed" } });
        assert_eq!(merge3(&stored, &base, &next), json!({ "shell": { "pathOverride": "/typed" } }));
    }

    #[test]
    fn a_key_the_window_removed_is_removed_and_one_it_added_is_added() {
        let base = json!({ "a": { "flag": true, "keep": 1 } });
        let stored = json!({ "a": { "flag": true, "keep": 1, "backend": "b" } });
        let next = json!({ "a": { "keep": 1, "added": "w" } });
        assert_eq!(merge3(&stored, &base, &next), json!({ "a": { "keep": 1, "backend": "b", "added": "w" } }));
    }

    #[test]
    fn nested_objects_merge_leaf_by_leaf() {
        let base = json!({ "outer": { "inner": { "x": 1, "y": 1 }, "z": 1 } });
        let stored = json!({ "outer": { "inner": { "x": 2, "y": 1 }, "z": 1 } });
        let next = json!({ "outer": { "inner": { "x": 1, "y": 3 }, "z": 4 } });
        assert_eq!(merge3(&stored, &base, &next), json!({ "outer": { "inner": { "x": 2, "y": 3 }, "z": 4 } }));
    }

    #[test]
    fn arrays_are_whole_values() {
        // The window didn't touch the list: the backend's whole list stays.
        let base = json!({ "list": ["a"], "other": 0 });
        let stored = json!({ "list": ["a", "b"], "other": 0 });
        let next = json!({ "list": ["a"], "other": 1 });
        assert_eq!(merge3(&stored, &base, &next), json!({ "list": ["a", "b"], "other": 1 }));
        // The window changed it: the window's whole list, not a union.
        let next = json!({ "list": ["c"], "other": 0 });
        assert_eq!(merge3(&stored, &base, &next), json!({ "list": ["c"], "other": 0 }));
    }

    #[test]
    fn keys_unknown_to_the_merge_round_trip() {
        // Nothing in this module names these keys.
        let base = json!({ "later": { "feature": { "n": [1, 2], "s": "x" } }, "plain": 1 });
        let stored = json!({ "later": { "feature": { "n": [1, 2, 3], "s": "x" } }, "plain": 1, "onlyStored": { "k": true } });
        let next = json!({ "later": { "feature": { "n": [1, 2], "s": "y" } }, "plain": 1 });
        assert_eq!(
            merge3(&stored, &base, &next),
            json!({ "later": { "feature": { "n": [1, 2, 3], "s": "y" } }, "plain": 1, "onlyStored": { "k": true } })
        );
    }

    #[test]
    fn a_window_save_with_nothing_changed_keeps_everything_stored() {
        let base = json!({ "a": 1, "b": { "c": [1] } });
        let stored = json!({ "a": 2, "b": { "c": [2] }, "d": null });
        assert_eq!(merge3(&stored, &base, &base), stored);
    }

    // ---- The store: backend writers under the lock, window saves merged ----

    fn store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        (dir, store)
    }

    fn on_disk(dir: &tempfile::TempDir) -> Settings {
        SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot()
    }

    #[test]
    fn program_folders_set_by_the_backend_survive_a_window_save_from_before_it() {
        let (dir, store) = store();
        let s0 = store.snapshot();
        store.update(|s| s.shell.path_override = Some("/opt/fixed/bin".into())).unwrap();
        // The window's preference save, built on the copy from before.
        let mut next = s0.clone();
        next.appearance.theme = ThemePref::Dark;
        let saved = store.replace_from(Some(s0), next).unwrap();
        assert_eq!(saved.shell.path_override.as_deref(), Some("/opt/fixed/bin"));
        assert_eq!(saved.appearance.theme, ThemePref::Dark);
        let disk = on_disk(&dir);
        assert_eq!(disk.shell.path_override.as_deref(), Some("/opt/fixed/bin"));
        assert_eq!(disk.appearance.theme, ThemePref::Dark);
    }

    #[test]
    fn the_lists_written_by_the_backend_survive_a_window_save() {
        let (_dir, store) = store();
        let s0 = store.snapshot();
        store.update(|s| s.team.ignored_repos.push("acme/old".into())).unwrap();
        store.update(|s| s.sharing.not_on_this_mac.push("acme/other".into())).unwrap();
        store.update(|s| s.identity.user_email = Some("me@example.com".into())).unwrap();
        let mut next = s0.clone();
        next.behavior.file_watcher_enabled = !s0.behavior.file_watcher_enabled;
        let saved = store.replace_from(Some(s0.clone()), next).unwrap();
        assert_eq!(saved.team.ignored_repos, vec!["acme/old".to_string()]);
        assert_eq!(saved.sharing.not_on_this_mac, vec!["acme/other".to_string()]);
        assert_eq!(saved.identity.user_email.as_deref(), Some("me@example.com"));
        assert_eq!(saved.behavior.file_watcher_enabled, !s0.behavior.file_watcher_enabled);
    }

    #[test]
    fn the_windows_own_change_to_program_folders_wins_over_the_backends() {
        let (dir, store) = store();
        let s0 = store.snapshot();
        store.update(|s| s.shell.path_override = Some("/from/repair".into())).unwrap();
        let mut next = s0.clone();
        next.shell.path_override = Some("/typed/by/person".into());
        store.replace_from(Some(s0), next).unwrap();
        assert_eq!(on_disk(&dir).shell.path_override.as_deref(), Some("/typed/by/person"));
    }

    #[test]
    fn the_window_clearing_a_field_clears_it() {
        let (dir, store) = store();
        store.update(|s| s.shell.path_override = Some("/x".into())).unwrap();
        let base = store.snapshot();
        let mut next = base.clone();
        next.shell.path_override = None;
        store.replace_from(Some(base), next).unwrap();
        assert_eq!(on_disk(&dir).shell.path_override, None);
    }

    #[test]
    fn without_a_base_the_save_is_whole_as_before() {
        let (_dir, store) = store();
        let s0 = store.snapshot();
        store.update(|s| s.shell.path_override = Some("/x".into())).unwrap();
        let saved = store.replace_from(None, s0).unwrap();
        assert_eq!(saved.shell.path_override, None);
    }

    #[test]
    fn two_backend_writers_and_the_window_interleaved_on_threads_all_land() {
        let (dir, store) = store();
        let store = std::sync::Arc::new(store);
        let rounds: u32 = 40;
        let email = {
            let store = store.clone();
            std::thread::spawn(move || {
                for i in 0..rounds {
                    store.update(|s| s.identity.user_email = Some(format!("{i}@example.com"))).unwrap();
                }
            })
        };
        let repos = {
            let store = store.clone();
            std::thread::spawn(move || {
                for i in 0..rounds {
                    store.update(|s| s.team.ignored_repos.push(format!("acme/r{i}"))).unwrap();
                }
            })
        };
        let window = {
            let store = store.clone();
            std::thread::spawn(move || {
                for i in 0..rounds {
                    // A copy that may already be stale when it is sent.
                    let base = store.snapshot();
                    let mut next = base.clone();
                    next.editor.tab_size = 1000 + i;
                    store.replace_from(Some(base), next).unwrap();
                }
            })
        };
        for t in [email, repos, window] {
            t.join().unwrap();
        }
        let disk = on_disk(&dir);
        assert_eq!(disk.identity.user_email.as_deref(), Some(format!("{}@example.com", rounds - 1).as_str()));
        assert_eq!(disk.team.ignored_repos.len(), rounds as usize, "no ignored repository was lost");
        assert_eq!(disk.editor.tab_size, 1000 + rounds - 1);
    }

    #[test]
    fn a_file_written_by_this_build_and_one_by_1_176_1_load_the_same() {
        // The schema is unchanged: what the merge writes is a plain settings
        // file, read back whole by the same `Settings` shape.
        let (dir, store) = store();
        let s0 = store.snapshot();
        store.update(|s| s.shell.path_override = Some("/x".into())).unwrap();
        let mut next = s0.clone();
        next.appearance.theme = ThemePref::Dark;
        let saved = store.replace_from(Some(s0), next).unwrap();
        let bytes = std::fs::read(dir.path().join("settings.json")).unwrap();
        let parsed: Settings = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), serde_json::to_value(&saved).unwrap());
    }

    // ---- Real `Settings` shapes (R2 review, F13) ----

    #[test]
    fn an_optional_struct_set_or_cleared_by_the_window_decodes_whole() {
        use crate::settings::{FirstCardGuide, SurfaceSize};
        let stored = Settings::default();
        // None → Some, on both value structs.
        let mut next = stored.clone();
        next.windows.settings = Some(SurfaceSize { width: 1200, height: 900 });
        next.onboarding.first_card = Some(FirstCardGuide {
            workspace_id: "ws".into(),
            card_id: "c1".into(),
            started_at: "2026-11-22T00:00:00Z".into(),
            ended_at: None,
            outcome: None,
        });
        let set = merge_settings(&stored, &stored, &next).unwrap();
        assert_eq!(set.windows.settings.as_ref().map(|s| (s.width, s.height)), Some((1200, 900)));
        assert_eq!(set.onboarding.first_card.as_ref().map(|c| c.card_id.as_str()), Some("c1"));
        // Some → None.
        let mut cleared = set.clone();
        cleared.windows.settings = None;
        cleared.onboarding.first_card = None;
        let back = merge_settings(&set, &set, &cleared).unwrap();
        assert!(back.windows.settings.is_none());
        assert!(back.onboarding.first_card.is_none());
    }

    #[test]
    fn a_reset_shaped_save_keeps_a_backend_value_the_window_never_saw() {
        // The merge alone, on a reset-shaped save: Program folders written by
        // Repair after the window's base stays. That is why a reset is not
        // this merge alone: since 1.176.3 (owner) it names the paths it puts
        // back, whatever wrote them (`settings_reset::merge_forcing`).
        let base = Settings::default();
        let mut stored = base.clone();
        stored.shell.path_override = Some("/from/repair".into());
        let mut next = Settings::default();
        next.identity = base.identity.clone();
        next.team = base.team.clone();
        next.sharing = base.sharing.clone();
        next.appearance.theme = ThemePref::Dark;
        let merged = merge_settings(&stored, &base, &next).unwrap();
        assert_eq!(merged.shell.path_override.as_deref(), Some("/from/repair"));
        assert_eq!(merged.appearance.theme, ThemePref::Dark);
    }

    #[test]
    fn an_empty_map_in_the_base_is_absent_so_the_windows_first_entry_is_taken_whole() {
        // F3 as it stands (a follow-up): `nextImprovement.view` is left out of
        // the file when empty, so a stale base with no entries makes the
        // window's map replace the stored one. Only the window writes it.
        use crate::settings::NiSlateView;
        let base = Settings::default();
        let mut stored = base.clone();
        stored.next_improvement.view.insert("ws::a".into(), NiSlateView { seen_round: None, collapsed: Some(true) });
        let mut next = base.clone();
        next.next_improvement.view.insert("ws::b".into(), NiSlateView { seen_round: None, collapsed: Some(true) });
        let merged = merge_settings(&stored, &base, &next).unwrap();
        assert_eq!(merged.next_improvement.view.keys().cloned().collect::<Vec<_>>(), vec!["ws::b".to_string()]);
    }

    #[test]
    fn backend_owned_fields_stay_after_the_merge_when_the_base_lacks_them() {
        let (_dir, store) = store();
        store.set_team_repo(Some("acme/team".into())).unwrap();
        store.ensure_device(|| "Desk".into(), || "hw-1".into()).unwrap();
        // The window's copy has neither (`Settings::default()`).
        let base = Settings::default();
        let mut next = base.clone();
        next.appearance.theme = ThemePref::Dark;
        let saved = store.replace_from(Some(base), next).unwrap();
        assert_eq!(saved.team.team_repo.as_deref(), Some("acme/team"));
        assert_eq!(saved.device.name.as_deref(), Some("Desk"));
        assert!(saved.device.id.is_some());
        assert_eq!(saved.appearance.theme, ThemePref::Dark);
    }

    // ---- Every backend writer goes through the locked `update` ----

    /// The body of `fn <name>` in `source`, up to the next top-level item.
    fn body<'a>(source: &'a str, name: &str) -> &'a str {
        let at = [format!("fn {name}("), format!("fn {name}<")]
            .iter()
            .find_map(|head| source.find(head.as_str()))
            .unwrap_or_else(|| panic!("fn {name} not found"));
        let rest = &source[at..];
        let end = rest[1..].find("\n}\n").map(|e| e + 1).unwrap_or(rest.len());
        &rest[..end]
    }

    #[test]
    fn every_backend_writer_mutates_settings_under_the_stores_lock() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let read = |f: &str| std::fs::read_to_string(src.join(f)).unwrap();
        let writers = [
            ("program_folders.rs", "save_override"),
            ("commands.rs", "team_discovery_ignore"),
            ("commands.rs", "team_discovery_clear_ignored"),
            ("workspace_adoption.rs", "app_decline"),
            ("setup_identity.rs", "setup_identity_write"),
        ];
        for (file, name) in writers {
            let source = read(file);
            let code = body(&source, name);
            assert!(code.contains(".update("), "{file} {name} writes through the store's locked update");
            assert!(!code.contains(".replace("), "{file} {name} never replaces the whole settings");
            assert!(!code.contains(".snapshot()"), "{file} {name} reads under the lock, not before it");
        }
        // The two launch backfills.
        let lib = read("lib.rs");
        assert!(!lib.contains("settings_store.replace("), "lib.rs backfills go through update");
        assert_eq!(lib.matches("settings_store.update(").count(), 2, "both lib.rs backfills use update");
        // `replace` exists only for tests; the one production whole-value
        // write is the window's `settings_set`, merged against its base.
        let settings = read("settings.rs");
        assert!(settings.contains("#[cfg(test)]\n    pub fn replace("), "replace is test-only");
        let mut callers = 0;
        for entry in std::fs::read_dir(&src).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !name.ends_with(".rs") || name.ends_with("_tests.rs") || name == "settings_merge.rs" || name == "settings.rs" {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            callers += source.matches(".replace_from(").count();
        }
        assert_eq!(callers, 1, "only settings_set saves a whole value, with its base");
        let commands = read("commands.rs");
        let set = body(&commands, "settings_set");
        assert!(set.contains("replace_from(base, settings)"), "settings_set merges against the window's base");
        // 1.176.3: a reset is the window's other save: merged the same way,
        // then the paths it names put back (`settings_reset`).
        let reset = read("settings_reset.rs");
        assert!(body(&reset, "settings_reset").contains("store.reset_from(base, settings, &paths)"));
        // Review S3: both window saves run the same after-save effects (the
        // PATH override and its re-probe, the watcher, `settings://changed`).
        assert!(body(&reset, "settings_reset").contains("after_window_save("), "a reset runs the after-save effects");
        assert!(set.contains("after_window_save("), "settings_set runs the after-save effects");
    }

    #[test]
    fn save_override_tells_the_window_before_the_slow_re_probe() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/program_folders.rs"),
        )
        .unwrap();
        let code = body(&source, "save_override");
        let told = code.find("\"settings://changed\"").expect("save_override emits settings://changed");
        let probe = code.find("re_probe_and_forget(").expect("save_override re-probes");
        assert!(told < probe, "the window hears the new value before the re-probe starts");
    }
}
