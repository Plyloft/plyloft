//! 1.176.3 (owner, 2026-11-23): a reset puts back every setting it covers,
//! whatever wrote it.
//!
//! A window save is a three-way merge (`settings_merge`): a key the window
//! didn't change keeps what is stored, so a value Plyloft wrote after the
//! window's copy (Program folders after a Repair) survives. That protection
//! is right for a save, and wrong for a reset: "Reset all settings on this
//! Mac" and a page's "Reset this page to defaults" sent the defaults against
//! a copy that already held them, and the value Plyloft had just written
//! stayed. A reset now names the paths it covers; they take the window's
//! value (the default) under the store's lock, and every other key is merged
//! as before, so another page's value the backend wrote meanwhile stays.

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::settings::{Settings, SettingsStore};
use crate::watcher::WatcherRegistry;

/// Every path a reset may name (1.176.3, review S2): the blocks "Reset all
/// settings on this Mac" puts back (`settingsFields.ts::resetAllPaths`) and
/// what each page's "Reset this page to defaults" names (`pageResetPaths`, on
/// the pages that draw one). A path outside it is refused, never written.
/// `settingsFields.test.ts` keeps it equal to the TypeScript lists.
pub const RESETTABLE_PATHS: &[&str] = &[
    "appearance",
    "appearance.accent",
    "appearance.screenReader",
    "appearance.theme",
    "behavior.autoCloseFinishedRunTiles",
    "behavior.autoResumeSuspended",
    "behavior.builderPermissions",
    "behavior.builderVendor",
    "behavior.checkFixRoundsByItself",
    "behavior.commandBlocksEnabled",
    "behavior.confirmQuitWithWorkingSessions",
    "behavior.dictation",
    "behavior.dictation.enabled",
    "behavior.dictation.language",
    "behavior.dictation.model",
    "behavior.discussionSynthesizer",
    "behavior.externalWriteReloadStrategy",
    "behavior.fileWatcherEnabled",
    "behavior.injectGlobalMemories",
    "behavior.lastBuilderVendor",
    "behavior.models",
    "behavior.models.claude.builder",
    "behavior.models.claude.builderReasoning",
    "behavior.models.claude.challenger",
    "behavior.models.claude.challengerReasoning",
    "behavior.models.codex.builder",
    "behavior.models.codex.builderReasoning",
    "behavior.models.codex.challenger",
    "behavior.models.codex.challengerReasoning",
    "behavior.notifyOnAgentDone",
    "behavior.notifyOnSessionWaiting",
    "behavior.openOn",
    "behavior.runHistoryRetention",
    "behavior.runHistoryRetention.days",
    "behavior.runHistoryRetention.maxRuns",
    "behavior.windowsCloseAction",
    "editor",
    "editor.lineNumbers",
    "editor.showHiddenFiles",
    "editor.tabSize",
    "editor.textSize",
    "editor.wordWrap",
    "shell",
    "shell.pathOverride",
    "shell.tileShell",
    "terminals",
    "terminals.defaultNewPaneKind",
    "terminals.newTileKind",
    "terminals.scrollbackLines",
    "terminals.textSize",
    "windows",
];

/// [`crate::settings_merge::merge_settings`], then each dotted path in
/// `paths` set to `next`'s value there (removed where `next` has none).
/// Where a parent of the path is missing or not an object on the merged side,
/// the shallowest such parent is taken whole from `next`, so no partial
/// object is ever made.
pub fn merge_forcing(stored: &Settings, base: &Settings, next: &Settings, paths: &[String]) -> Result<Settings, String> {
    if let Some(unknown) = paths.iter().find(|p| !RESETTABLE_PATHS.contains(&p.as_str())) {
        return Err(format!("{unknown} is not a setting a reset puts back."));
    }
    let encode = |s: &Settings| serde_json::to_value(s).map_err(|e| format!("encode: {e}"));
    let next_value = encode(next)?;
    let mut merged = crate::settings_merge::merge3(&encode(stored)?, &encode(base)?, &next_value);
    for path in paths {
        force(&mut merged, &next_value, path);
    }
    serde_json::from_value(merged).map_err(|e| format!("decode: {e}"))
}

/// `merged` at `path` becomes `next` at `path`.
pub fn force(merged: &mut Value, next: &Value, path: &str) {
    let keys: Vec<&str> = path.split('.').filter(|k| !k.is_empty()).collect();
    let mut at = merged;
    let mut from = Some(next);
    for (i, key) in keys.iter().enumerate() {
        let Value::Object(map) = at else { return };
        from = from.and_then(|v| v.get(*key));
        let last = i + 1 == keys.len();
        let descend = !last && matches!(map.get(*key), Some(Value::Object(_)));
        if !descend {
            match from {
                Some(value) => {
                    map.insert((*key).to_string(), value.clone());
                }
                None => {
                    map.remove(*key);
                }
            }
            return;
        }
        at = map.get_mut(*key).expect("checked above");
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsReset {
    /// What was stored just before the reset: what its Undo puts back.
    pub before: Settings,
    pub saved: Settings,
}

/// The window's reset: `settings` is the window's copy with the reset
/// applied, `base` the copy it was applied to, `paths` what the reset covers.
#[tauri::command]
pub fn settings_reset(
    app: tauri::AppHandle,
    store: State<'_, SettingsStore>,
    watcher: State<'_, WatcherRegistry>,
    settings: Settings,
    base: Settings,
    paths: Vec<String>,
) -> Result<SettingsReset, String> {
    let (before, saved) = store.reset_from(base, settings, &paths)?;
    crate::commands::after_window_save(&app, &watcher, before.card_swarm_cap(), &saved);
    Ok(SettingsReset { before, saved })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ThemePref;
    use serde_json::json;

    fn store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().to_path_buf()).unwrap();
        (dir, store)
    }

    fn on_disk(dir: &tempfile::TempDir) -> Settings {
        SettingsStore::new(dir.path().to_path_buf()).unwrap().snapshot()
    }

    fn paths(p: &[&str]) -> Vec<String> {
        p.iter().map(|s| s.to_string()).collect()
    }

    /// The blocks "Reset all settings on this Mac" puts back
    /// (`settingsFields.ts::resetAllPaths`).
    const RESET_ALL: &[&str] = &[
        "appearance",
        "terminals",
        "shell",
        "windows",
        "editor",
        "behavior.fileWatcherEnabled",
        "behavior.externalWriteReloadStrategy",
        "behavior.notifyOnAgentDone",
        "behavior.notifyOnSessionWaiting",
        "behavior.runHistoryRetention",
        "behavior.commandBlocksEnabled",
        "behavior.autoResumeSuspended",
        "behavior.autoCloseFinishedRunTiles",
        "behavior.injectGlobalMemories",
        "behavior.openOn",
        "behavior.discussionSynthesizer",
        "behavior.builderVendor",
        "behavior.models",
        "behavior.dictation",
        "behavior.checkFixRoundsByItself",
        "behavior.lastBuilderVendor",
    ];

    /// The window's `resetAllOnThisMac` on its copy: the six blocks back to
    /// how Plyloft ships, the records kept.
    fn reset_all_of(copy: &Settings) -> Settings {
        let d = Settings::default();
        let mut next = copy.clone();
        next.appearance = d.appearance;
        next.terminals = d.terminals;
        next.shell = d.shell;
        next.windows = d.windows;
        next.editor = d.editor;
        // S1 (owner): the three answers given once stay.
        next.behavior = crate::settings::BehaviorSettings {
            builder_permissions: copy.behavior.builder_permissions,
            windows_close_action: copy.behavior.windows_close_action,
            confirm_quit_with_working_sessions: copy.behavior.confirm_quit_with_working_sessions,
            ..d.behavior
        };
        next
    }

    #[test]
    fn reset_all_keeps_the_three_answers_given_once() {
        // S1 (owner, 2026-11-23): the quit sheet's "Don't ask again", the
        // remembered close choice and how the Builder asks you survive Reset
        // all; the rest of behavior goes back.
        let (_dir, store) = store();
        let copy = store
            .update(|s| {
                s.behavior.confirm_quit_with_working_sessions = false;
                s.behavior.windows_close_action = serde_json::from_value(json!("quit")).unwrap();
                s.behavior.builder_permissions = serde_json::from_value(json!("neverAsks")).unwrap();
                s.behavior.command_blocks_enabled = !Settings::default().behavior.command_blocks_enabled;
            })
            .unwrap();
        let (_, saved) = store.reset_from(copy.clone(), reset_all_of(&copy), &paths(RESET_ALL)).unwrap();
        let b = serde_json::to_value(&saved.behavior).unwrap();
        assert_eq!(b["confirmQuitWithWorkingSessions"], json!(false));
        assert_eq!(b["windowsCloseAction"], json!("quit"));
        assert_eq!(b["builderPermissions"], json!("neverAsks"));
        assert_eq!(saved.behavior.command_blocks_enabled, Settings::default().behavior.command_blocks_enabled);
        // And the whole block can no longer be named.
        let err = store.reset_from(copy.clone(), reset_all_of(&copy), &paths(&["behavior"])).unwrap_err();
        assert!(err.contains("behavior"), "{err}");
    }

    #[test]
    fn reset_all_clears_program_folders_plyloft_wrote_after_the_windows_copy() {
        let (dir, store) = store();
        let copy = store.snapshot();
        // Repair writes Program folders; the window hasn't heard yet.
        store.update(|s| s.shell.path_override = Some("/from/repair".into())).unwrap();
        let (before, saved) = store.reset_from(copy.clone(), reset_all_of(&copy), &paths(RESET_ALL)).unwrap();
        assert_eq!(saved.shell.path_override, None, "Reset all clears it, whatever wrote it");
        assert_eq!(on_disk(&dir).shell.path_override, None);
        assert_eq!(before.shell.path_override.as_deref(), Some("/from/repair"), "what the Undo would put back");
    }

    #[test]
    fn reset_all_still_keeps_the_records_plyloft_wrote_meanwhile() {
        // The blocks Reset all keeps on purpose (onboarding, identity, team,
        // sharing, library, projects, nextImprovement) keep a backend write
        // the window's copy didn't have yet.
        let (_dir, store) = store();
        let copy = store.snapshot();
        store.update(|s| s.team.ignored_repos.push("acme/old".into())).unwrap();
        store.update(|s| s.sharing.not_on_this_mac.push("acme/other".into())).unwrap();
        store.update(|s| s.identity.user_email = Some("me@example.com".into())).unwrap();
        store.set_team_repo(Some("acme/team".into())).unwrap();
        let (_, saved) = store.reset_from(copy.clone(), reset_all_of(&copy), &paths(RESET_ALL)).unwrap();
        assert_eq!(saved.team.ignored_repos, vec!["acme/old".to_string()]);
        assert_eq!(saved.sharing.not_on_this_mac, vec!["acme/other".to_string()]);
        assert_eq!(saved.identity.user_email.as_deref(), Some("me@example.com"));
        assert_eq!(saved.team.team_repo.as_deref(), Some("acme/team"));
    }

    #[test]
    fn reset_all_keeps_the_swarm_keys_the_window_does_not_carry() {
        // Today's behaviour, kept: `keep_backend_owned` restores them after
        // any window save, a reset included.
        let (_dir, store) = store();
        store
            .update(|s| {
                s.behavior.max_concurrent_card_swarms = 7;
                s.behavior.swarm_artifact_retention_days = Some(3);
            })
            .unwrap();
        let copy = store.snapshot();
        let (_, saved) = store.reset_from(copy.clone(), reset_all_of(&copy), &paths(RESET_ALL)).unwrap();
        assert_eq!(saved.behavior.max_concurrent_card_swarms, 7);
        assert_eq!(saved.behavior.swarm_artifact_retention_days, Some(3));
    }

    #[test]
    fn a_page_reset_clears_its_own_key_plyloft_wrote_and_leaves_other_pages() {
        let (dir, store) = store();
        // The window had set the tab size; its copy has it.
        let copy = store
            .update(|s| {
                s.editor.tab_size = 8;
                s.appearance.theme = ThemePref::Dark;
            })
            .unwrap();
        // Then Repair writes Program folders (this page) and the git email
        // (another page) before the window hears of either.
        store.update(|s| s.shell.path_override = Some("/from/repair".into())).unwrap();
        store.update(|s| s.identity.user_email = Some("me@example.com".into())).unwrap();
        // Editor and terminals' reset, on the window's copy.
        let mut next = copy.clone();
        next.editor.tab_size = Settings::default().editor.tab_size;
        next.shell.path_override = None;
        let (before, saved) = store
            .reset_from(copy.clone(), next, &paths(&["editor.tabSize", "shell.pathOverride"]))
            .unwrap();
        assert_eq!(saved.shell.path_override, None, "this page's key Plyloft wrote is reset");
        assert_eq!(saved.editor.tab_size, Settings::default().editor.tab_size);
        assert_eq!(saved.identity.user_email.as_deref(), Some("me@example.com"), "another page's stays");
        assert_eq!(saved.appearance.theme, ThemePref::Dark, "another page's own value stays");
        assert_eq!(on_disk(&dir).shell.path_override, None);
        assert_eq!(before.shell.path_override.as_deref(), Some("/from/repair"));
        // The Undo: an ordinary merged save of `before`'s values onto what was
        // saved (no paths named: `replace_from`'s merge).
        let mut undo = saved.clone();
        undo.shell.path_override = before.shell.path_override.clone();
        undo.editor.tab_size = before.editor.tab_size;
        let (_, back) = store.reset_from(saved, undo, &[]).unwrap();
        assert_eq!(back.shell.path_override.as_deref(), Some("/from/repair"), "Undo puts Plyloft's value back");
        assert_eq!(back.editor.tab_size, 8);
    }

    #[test]
    fn force_takes_the_shallowest_missing_parent_whole() {
        // `windows.settings` is null on the merged side: forcing a leaf under
        // it takes the whole object from `next`, never a partial one.
        let mut merged = json!({ "windows": { "settings": null, "page": "a" } });
        let next = json!({ "windows": { "settings": { "width": 1, "height": 2 }, "page": "b" } });
        force(&mut merged, &next, "windows.settings.width");
        assert_eq!(merged, json!({ "windows": { "settings": { "width": 1, "height": 2 }, "page": "a" } }));
        // A key `next` doesn't have is removed.
        let mut merged = json!({ "behavior": { "models": { "claude": { "builder": "opus" } } } });
        let next = json!({ "behavior": { "models": { "claude": {} } } });
        force(&mut merged, &next, "behavior.models.claude.builder");
        assert_eq!(merged, json!({ "behavior": { "models": { "claude": {} } } }));
        // A whole block.
        let mut merged = json!({ "shell": { "pathOverride": "/x" }, "team": { "k": 1 } });
        let next = json!({ "shell": { "pathOverride": null }, "team": { "k": 0 } });
        force(&mut merged, &next, "shell");
        assert_eq!(merged, json!({ "shell": { "pathOverride": null }, "team": { "k": 1 } }));
    }

    #[test]
    fn a_path_outside_the_resettable_list_is_refused_and_nothing_is_written() {
        let (dir, store) = store();
        store.update(|s| s.identity.user_email = Some("me@example.com".into())).unwrap();
        let copy = store.snapshot();
        let mut next = copy.clone();
        next.identity.user_email = None;
        next.appearance.theme = ThemePref::Dark;
        for path in ["identity", "identity.userEmail", "appearance.theem", "onboarding"] {
            let err = store.reset_from(copy.clone(), next.clone(), &paths(&["appearance", path])).unwrap_err();
            assert!(err.contains(path), "{err}");
        }
        let disk = on_disk(&dir);
        assert_eq!(disk.identity.user_email.as_deref(), Some("me@example.com"));
        assert_ne!(disk.appearance.theme, ThemePref::Dark, "nothing of a refused reset is written");
    }

    #[test]
    fn every_resettable_path_is_a_real_path_of_the_settings() {
        // A leaf left out of the file when unset (`skip_serializing_if`) is
        // read off a value that holds it.
        let mut s = Settings::default();
        s.appearance.screen_reader = Some(true);
        s.terminals.new_tile_kind = serde_json::from_value(json!("codex")).unwrap();
        s.terminals.text_size = Some(14);
        s.editor.text_size = Some(14);
        s.shell.path_override = Some("/x".into());
        s.shell.tile_shell = Some("/bin/zsh".into());
        s.behavior.last_builder_vendor = serde_json::from_value(json!("codex")).unwrap();
        s.behavior.models = serde_json::from_value(json!({
            "claude": { "builder": "a", "challenger": "b", "builderReasoning": "c", "challengerReasoning": "d" },
            "codex": { "builder": "a", "challenger": "b", "builderReasoning": "c", "challengerReasoning": "d" }
        }))
        .unwrap();
        s.behavior.run_history_retention.days = Some(1);
        s.behavior.run_history_retention.max_runs = Some(1);
        s.behavior.open_on = serde_json::from_value(json!("board")).unwrap();
        let value = serde_json::to_value(&s).unwrap();
        for path in RESETTABLE_PATHS {
            let found = path.split('.').try_fold(&value, |v, k| v.get(k));
            assert!(found.is_some(), "{path} is a path of settings.json");
        }
    }

    #[test]
    fn a_reset_with_no_paths_is_the_ordinary_merge() {
        let (_dir, store) = store();
        let copy = store.snapshot();
        store.update(|s| s.shell.path_override = Some("/x".into())).unwrap();
        let (_, saved) = store.reset_from(copy.clone(), reset_all_of(&copy), &[]).unwrap();
        assert_eq!(saved.shell.path_override.as_deref(), Some("/x"));
    }
}
