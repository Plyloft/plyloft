//! Prompts library — saved system + user prompts reusable across agents.
//!
//! Stored as a single flat file at `<config_dir>/prompts/library.json`.
//! Atomic writes via tempfile + rename (Hard Rule #3). Schema is versioned
//! (v1 in this release); future bumps must update `PROMPTS_SCHEMA_VERSION`
//! and add a migration path or reject older versions cleanly.
//!
//! v0.8.0: introduced.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::shared_library::{
    delete_library_file, read_library_file, write_library_file, LibraryScope,
};

const PROMPTS_SUBDIR: &str = "prompts";
const PROMPTS_FILE: &str = "library.json";
/// v1.54.0 (Team Mode): the team-shared prompts overlay is named
/// `prompts.json` inside `<cwd>/.atelier/library/` — NOT `library.json`.
/// The personal store keeps `library.json` (see `PROMPTS_FILE`) so
/// existing personal libraries aren't orphaned, but the committed,
/// teammate-facing file gets a name consistent with its siblings
/// `swarm_templates.json` and `templates.json`. v1.50.0–v1.53.0 wrote
/// the shared file as `library.json` by reusing `PROMPTS_FILE`; the
/// loader migrates any such legacy file forward on read (see
/// `read_shared_prompts`).
const SHARED_PROMPTS_FILE: &str = "prompts.json";
/// The pre-v1.54.0 shared filename, kept only for one-way read
/// migration.
const LEGACY_SHARED_PROMPTS_FILE: &str = "library.json";
const PROMPTS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub prompt_template: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// v1.49.0 (Team Mode Phase 0): provenance fields. `author` is stamped
    /// at create-time and never changes; `last_edited_by` is stamped on
    /// every mutate. Both are the email from `settings.identity.user_email`
    /// (cached at startup from `git config --global user.email`). `None`
    /// on legacy rows or when no identity is configured.
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub last_edited_by: Option<String>,
    /// v1.50.0 (Team Mode Phase 2): runtime-only scope tag. Set by the
    /// loader (`list_all_with_shared`) to `Shared` when the prompt was
    /// read from the active workspace's `.atelier/library/prompts.json`,
    /// `Personal` when read from the global personal store. Never
    /// persisted (the on-disk file's layer is implicit from its path).
    /// The frontend renders this as a "Shared (.atelier)" / "Personal"
    /// chip in the prompts library list.
    #[serde(default = "default_scope", skip_serializing)]
    pub scope: LibraryScope,
}

fn default_scope() -> LibraryScope {
    LibraryScope::Personal
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptsFile {
    pub version: u32,
    #[serde(default)]
    pub prompts: Vec<Prompt>,
}

impl Default for PromptsFile {
    fn default() -> Self {
        Self {
            version: PROMPTS_SCHEMA_VERSION,
            prompts: Vec::new(),
        }
    }
}

pub struct PromptsStore {
    path: PathBuf,
    cache: Mutex<Vec<Prompt>>,
    loaded: Mutex<bool>,
}

impl PromptsStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        let dir = config_dir.join(PROMPTS_SUBDIR);
        fs::create_dir_all(&dir).map_err(|e| format!("create prompts dir: {e}"))?;
        Ok(Self {
            path: dir.join(PROMPTS_FILE),
            cache: Mutex::new(Vec::new()),
            loaded: Mutex::new(false),
        })
    }

    pub fn list(&self) -> Result<Vec<Prompt>, String> {
        if *self.loaded.lock() {
            return Ok(self.cache.lock().clone());
        }
        let prompts = if self.path.exists() {
            let bytes = fs::read(&self.path).map_err(|e| format!("read prompts: {e}"))?;
            if bytes.is_empty() {
                Vec::new()
            } else {
                let parsed: PromptsFile = match serde_json::from_slice(&bytes) {
                    Ok(p) => p,
                    Err(e) => {
                        log::error!("prompts: parse failed ({e}); returning empty");
                        return Ok(Vec::new());
                    }
                };
                if parsed.version != PROMPTS_SCHEMA_VERSION {
                    log::warn!(
                        "prompts: file has version {} (expected {}); ignoring",
                        parsed.version,
                        PROMPTS_SCHEMA_VERSION
                    );
                    return Ok(Vec::new());
                }
                parsed.prompts
            }
        } else {
            Vec::new()
        };
        *self.cache.lock() = prompts.clone();
        *self.loaded.lock() = true;
        Ok(prompts)
    }

    fn save_all(&self, prompts: Vec<Prompt>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
        }
        let file = PromptsFile {
            version: PROMPTS_SCHEMA_VERSION,
            prompts: prompts.clone(),
        };
        let json = serde_json::to_vec_pretty(&file).map_err(|e| format!("encode: {e}"))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
        crate::platform::rename(&tmp, &self.path).map_err(|e| format!("rename: {e}"))?;
        *self.cache.lock() = prompts;
        *self.loaded.lock() = true;
        Ok(())
    }

    pub fn create(
        &self,
        mut prompt: Prompt,
        author_email: Option<String>,
    ) -> Result<Prompt, String> {
        let now = chrono::Utc::now().timestamp_millis();
        prompt.id = uuid::Uuid::new_v4().to_string();
        prompt.created_at = now;
        prompt.updated_at = now;
        // v1.49.0 (Team Mode Phase 0): stamp provenance from the cached
        // identity. Callers pass `None` if identity is unset (the field
        // stays None and the UI shows "Unknown").
        prompt.author = author_email.clone();
        prompt.last_edited_by = author_email;
        let mut prompts = self.list()?;
        prompts.push(prompt.clone());
        self.save_all(prompts)?;
        Ok(prompt)
    }

    pub fn update(
        &self,
        mut prompt: Prompt,
        author_email: Option<String>,
    ) -> Result<Prompt, String> {
        let now = chrono::Utc::now().timestamp_millis();
        prompt.updated_at = now;
        let mut prompts = self.list()?;
        let idx = prompts.iter().position(|p| p.id == prompt.id).ok_or_else(
            || format!("prompt not found: {}", prompt.id),
        )?;
        // Preserve created_at + original author from existing record.
        prompt.created_at = prompts[idx].created_at;
        prompt.author = prompts[idx].author.clone();
        prompt.last_edited_by = author_email;
        prompts[idx] = prompt.clone();
        self.save_all(prompts)?;
        Ok(prompt)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut prompts = self.list()?;
        let before = prompts.len();
        prompts.retain(|p| p.id != id);
        if prompts.len() == before {
            return Err(format!("prompt not found: {id}"));
        }
        self.save_all(prompts)
    }

    /// v1.50.0 (Team Mode Phase 2): return personal prompts tagged
    /// `Scope::Personal`, optionally additively merged with shared
    /// prompts read from `<project_cwd>/.atelier/library/prompts.json`
    /// tagged `Scope::Shared`. Same-ID collisions resolve in favor of
    /// the shared entry (per plan: "additive sets, shared wins on
    /// collision"; a personal override means a different ID, surfaced
    /// later via the Fork lifecycle action).
    ///
    /// v1.52.0 (Team Mode Phase 2.3): promote a personal prompt to the
    /// team-shared overlay at `<project_cwd>/.atelier/library/prompts.json`.
    /// Removes the entry from the personal layer; writes (or extends)
    /// the shared file. The id is preserved across the move so any
    /// downstream reference stays valid. Atomic on both layers (Hard
    /// Rule #3).
    ///
    /// Errors if the personal prompt doesn't exist. Idempotent against
    /// already-promoted ids: if the shared file already has an entry
    /// with the same id, the shared entry is overwritten with the
    /// personal copy (re-promote = "make the shared version match
    /// what I had in personal").
    /// v1.54.0: read the shared prompts overlay, migrating the
    /// pre-v1.54 `library.json` filename to `prompts.json` on first
    /// touch. Returns `Ok(None)` when neither file exists.
    ///
    /// Migration is one-way and best-effort: if a legacy
    /// `library.json` is found and no `prompts.json` yet exists, its
    /// contents are rewritten to `prompts.json` and the legacy file
    /// removed. A failure to migrate isn't fatal — the legacy
    /// contents are still returned so the caller sees the prompts.
    fn read_shared_prompts(
        project_cwd: &Path,
    ) -> Result<Option<PromptsFile>, String> {
        if let Some(current) =
            read_library_file::<PromptsFile>(Some(project_cwd), SHARED_PROMPTS_FILE)?
        {
            return Ok(Some(current));
        }
        // No prompts.json — check for a legacy library.json to migrate.
        match read_library_file::<PromptsFile>(
            Some(project_cwd),
            LEGACY_SHARED_PROMPTS_FILE,
        )? {
            Some(legacy) => {
                if let Err(e) =
                    write_library_file(project_cwd, SHARED_PROMPTS_FILE, &legacy)
                {
                    log::warn!(
                        "prompts: shared library.json → prompts.json migration write failed ({e}); returning legacy contents"
                    );
                } else {
                    let _ = delete_library_file(
                        project_cwd,
                        LEGACY_SHARED_PROMPTS_FILE,
                    );
                    log::info!(
                        "prompts: migrated shared library.json → prompts.json at {}",
                        project_cwd.display()
                    );
                }
                Ok(Some(legacy))
            }
            None => Ok(None),
        }
    }

    pub fn promote_to_shared(
        &self,
        id: &str,
        project_cwd: &Path,
    ) -> Result<Prompt, String> {
        let mut personal = self.list()?;
        let idx = personal
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| format!("prompt not found in personal: {id}"))?;
        let mut promoted = personal.remove(idx);
        promoted.scope = LibraryScope::Personal; // not persisted; reset for safety
        // Load shared, replace/insert by id, write back.
        let mut shared: PromptsFile =
            Self::read_shared_prompts(project_cwd)?.unwrap_or_default();
        shared.prompts.retain(|p| p.id != id);
        shared.prompts.push(promoted.clone());
        write_library_file(project_cwd, SHARED_PROMPTS_FILE, &shared)?;
        // Persist the removal from personal.
        self.save_all(personal)?;
        promoted.scope = LibraryScope::Shared;
        Ok(promoted)
    }

    /// v1.52.0: demote a shared prompt back into the personal layer.
    /// Removes the entry from the repo's `prompts.json`; adds it to
    /// the personal store. Inverse of `promote_to_shared`. If the
    /// shared file becomes empty after the removal, the file is
    /// removed (and `.atelier/library/` pruned if empty).
    pub fn demote_to_personal(
        &self,
        id: &str,
        project_cwd: &Path,
    ) -> Result<Prompt, String> {
        let mut shared: PromptsFile = Self::read_shared_prompts(project_cwd)?
            .ok_or_else(|| {
                "no shared library at <cwd>/.atelier/library/prompts.json".to_string()
            })?;
        let idx = shared
            .prompts
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| format!("prompt not found in shared: {id}"))?;
        let mut demoted = shared.prompts.remove(idx);
        // Write shared back (or remove the file if it became empty).
        if shared.prompts.is_empty() {
            delete_library_file(project_cwd, SHARED_PROMPTS_FILE)?;
        } else {
            write_library_file(project_cwd, SHARED_PROMPTS_FILE, &shared)?;
        }
        // Add to personal. Same-id collisions in personal are unlikely
        // (shared-wins-on-collision in the loader means a duplicate
        // would have been hidden), but be defensive.
        let mut personal = self.list()?;
        personal.retain(|p| p.id != id);
        demoted.scope = LibraryScope::Personal;
        personal.push(demoted.clone());
        self.save_all(personal)?;
        Ok(demoted)
    }

    /// v1.52.0: fork a shared prompt into a personal copy with a fresh
    /// id. The shared entry stays put; the user gets an independent
    /// personal entry to edit without disturbing the team library.
    /// Stamps the forker's email on both `author` and `lastEditedBy`.
    pub fn fork_to_personal(
        &self,
        id: &str,
        project_cwd: &Path,
        author_email: Option<String>,
    ) -> Result<Prompt, String> {
        let shared: PromptsFile = Self::read_shared_prompts(project_cwd)?
            .ok_or_else(|| {
                "no shared library at <cwd>/.atelier/library/prompts.json".to_string()
            })?;
        let source = shared
            .prompts
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("prompt not found in shared: {id}"))?
            .clone();
        // create() fills a fresh UUID and stamps provenance from
        // the supplied email — the fork inherits no provenance
        // from the source.
        let mut fork = source;
        fork.id = String::new();
        fork.name = format!("{} (fork)", fork.name);
        self.create(fork, author_email)
    }

    /// Read-only — the personal-layer cache is unaffected by this call.
    /// Failure to read the shared file logs and degrades to personal-
    /// only; we don't want a malformed `.atelier/library/prompts.json`
    /// to break a workspace's entire prompt list.
    pub fn list_all_with_shared(
        &self,
        project_cwd: Option<&Path>,
    ) -> Result<Vec<Prompt>, String> {
        let mut personal = self.list()?;
        for p in personal.iter_mut() {
            p.scope = LibraryScope::Personal;
        }
        let shared: Option<PromptsFile> = match project_cwd {
            Some(cwd) => match Self::read_shared_prompts(cwd) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("prompts: shared library read failed ({e}); using personal only");
                    None
                }
            },
            None => None,
        };
        let Some(shared) = shared else {
            return Ok(personal);
        };
        if shared.version != PROMPTS_SCHEMA_VERSION {
            log::warn!(
                "prompts: shared library has version {} (expected {}); using personal only",
                shared.version,
                PROMPTS_SCHEMA_VERSION
            );
            return Ok(personal);
        }
        let shared_ids: std::collections::HashSet<&str> =
            shared.prompts.iter().map(|p| p.id.as_str()).collect();
        // Drop any personal entry whose id collides with a shared one
        // ("shared wins on collision").
        personal.retain(|p| !shared_ids.contains(p.id.as_str()));
        for mut s in shared.prompts {
            s.scope = LibraryScope::Shared;
            personal.push(s);
        }
        Ok(personal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample(name: &str) -> Prompt {
        Prompt {
            id: String::new(),
            name: name.into(),
            description: String::new(),
            system_prompt: "You are helpful.".into(),
            prompt_template: "Do the thing.".into(),
            tags: vec!["test".into()],
            created_at: 0,
            updated_at: 0,
            author: None,
            last_edited_by: None,
            scope: LibraryScope::Personal,
        }
    }

    #[test]
    fn create_assigns_id_and_timestamps() {
        let tmp = tempdir().unwrap();
        let store = PromptsStore::new(tmp.path().to_path_buf()).unwrap();
        let p = store.create(sample("first"), None).unwrap();
        assert!(!p.id.is_empty());
        assert!(p.created_at > 0);
        assert_eq!(p.updated_at, p.created_at);
    }

    #[test]
    fn list_persists_across_instances() {
        let tmp = tempdir().unwrap();
        let s1 = PromptsStore::new(tmp.path().to_path_buf()).unwrap();
        s1.create(sample("a"), None).unwrap();
        s1.create(sample("b"), None).unwrap();
        let s2 = PromptsStore::new(tmp.path().to_path_buf()).unwrap();
        let loaded = s2.list().unwrap();
        assert_eq!(loaded.len(), 2);
    }

    #[test]
    fn update_preserves_created_at_and_bumps_updated_at() {
        let tmp = tempdir().unwrap();
        let store = PromptsStore::new(tmp.path().to_path_buf()).unwrap();
        let mut p = store.create(sample("a"), None).unwrap();
        let original_created = p.created_at;
        std::thread::sleep(std::time::Duration::from_millis(2));
        p.name = "renamed".into();
        let updated = store.update(p, None).unwrap();
        assert_eq!(updated.created_at, original_created);
        assert!(updated.updated_at > original_created);
    }

    #[test]
    fn delete_removes_only_target() {
        let tmp = tempdir().unwrap();
        let store = PromptsStore::new(tmp.path().to_path_buf()).unwrap();
        let a = store.create(sample("a"), None).unwrap();
        let _b = store.create(sample("b"), None).unwrap();
        store.delete(&a.id).unwrap();
        let loaded = store.list().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "b");
    }

    /// v1.49.0 Tier 2 (Team Mode Phase 0): a pre-team-mode prompts/library.json
    /// (no `author` / `lastEditedBy` keys) loads cleanly with both fields
    /// defaulting to `None`. Established prompts created before identity
    /// shipped stay attribution-less; the UI shows "Unknown".
    #[test]
    fn legacy_prompts_load_with_provenance_none() {
        let pre_team_json = br#"{
            "version": 1,
            "prompts": [{
                "id": "abc",
                "name": "Test",
                "description": "",
                "systemPrompt": "x",
                "promptTemplate": "y",
                "tags": [],
                "createdAt": 1700000000000,
                "updatedAt": 1700000000000
            }]
        }"#;
        let parsed: PromptsFile = serde_json::from_slice(pre_team_json).expect("parse");
        assert_eq!(parsed.prompts.len(), 1);
        assert_eq!(parsed.prompts[0].author, None);
        assert_eq!(parsed.prompts[0].last_edited_by, None);
    }

    /// v1.50.0 (Team Mode Phase 2): `list_all_with_shared(None)` is
    /// equivalent to `list()` with every result tagged Personal — the
    /// backwards-compat path for workspaces that don't have a
    /// `.atelier/library/prompts.json`.
    #[test]
    fn list_all_with_shared_none_returns_personal_only() {
        let tmp = tempdir().unwrap();
        let store = PromptsStore::new(tmp.path().to_path_buf()).unwrap();
        store.create(sample("a"), None).unwrap();
        let loaded = store.list_all_with_shared(None).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].scope, LibraryScope::Personal);
    }

    /// v1.50.0: shared prompts in `<cwd>/.atelier/library/prompts.json`
    /// merge into the personal list, tagged Shared. Shared-id collisions
    /// resolve in favor of the shared entry.
    #[test]
    fn list_all_with_shared_merges_repo_library() {
        let tmp_app = tempdir().unwrap();
        let tmp_proj = tempdir().unwrap();
        let store = PromptsStore::new(tmp_app.path().to_path_buf()).unwrap();
        let _personal = store.create(sample("only-personal"), None).unwrap();
        let colliding = store
            .create(sample("personal-colliding"), Some("alice@x.com".into()))
            .unwrap();
        // Write a shared library file with one fresh prompt + one
        // colliding-with-personal prompt.
        let shared_path = tmp_proj
            .path()
            .join(".atelier/library")
            .join(SHARED_PROMPTS_FILE);
        fs::create_dir_all(shared_path.parent().unwrap()).unwrap();
        let shared_json = format!(
            r#"{{
                "version": 1,
                "prompts": [
                    {{
                        "id": "shared-only",
                        "name": "Shared",
                        "description": "",
                        "systemPrompt": "x",
                        "promptTemplate": "y",
                        "tags": [],
                        "createdAt": 1700000000000,
                        "updatedAt": 1700000000000,
                        "author": "team-author@example.com",
                        "lastEditedBy": "team-author@example.com"
                    }},
                    {{
                        "id": "{}",
                        "name": "Override",
                        "description": "",
                        "systemPrompt": "x",
                        "promptTemplate": "y",
                        "tags": [],
                        "createdAt": 1700000000000,
                        "updatedAt": 1700000000000,
                        "author": "team-author@example.com",
                        "lastEditedBy": "team-author@example.com"
                    }}
                ]
            }}"#,
            colliding.id
        );
        fs::write(&shared_path, shared_json).unwrap();
        let loaded = store
            .list_all_with_shared(Some(tmp_proj.path()))
            .unwrap();
        // Expected count: 1 personal-only + 1 shared-only + 1 shared
        // override (the colliding personal was dropped).
        assert_eq!(loaded.len(), 3);
        let personal_only = loaded
            .iter()
            .find(|p| p.name == "only-personal")
            .expect("personal-only present");
        assert_eq!(personal_only.scope, LibraryScope::Personal);
        let shared_only = loaded
            .iter()
            .find(|p| p.id == "shared-only")
            .expect("shared-only present");
        assert_eq!(shared_only.scope, LibraryScope::Shared);
        assert_eq!(
            shared_only.author.as_deref(),
            Some("team-author@example.com")
        );
        let override_entry = loaded
            .iter()
            .find(|p| p.id == colliding.id)
            .expect("override present");
        assert_eq!(override_entry.scope, LibraryScope::Shared);
        assert_eq!(override_entry.name, "Override");
    }

    /// v1.52.0 (Team Mode Phase 2.3): promote a personal prompt to
    /// the shared overlay. The id is preserved; personal layer drops
    /// the entry; `.atelier/library/prompts.json` gains it.
    #[test]
    fn promote_to_shared_moves_entry_into_atelier_library() {
        let tmp_app = tempdir().unwrap();
        let tmp_proj = tempdir().unwrap();
        let store = PromptsStore::new(tmp_app.path().to_path_buf()).unwrap();
        let p = store
            .create(sample("to-promote"), Some("alice@x.com".into()))
            .unwrap();
        let promoted = store.promote_to_shared(&p.id, tmp_proj.path()).unwrap();
        assert_eq!(promoted.id, p.id);
        assert_eq!(promoted.scope, LibraryScope::Shared);
        // Personal layer no longer contains it.
        let personal = store.list().unwrap();
        assert!(personal.iter().all(|x| x.id != p.id));
        // Shared file does.
        let shared: PromptsFile =
            read_library_file(Some(tmp_proj.path()), SHARED_PROMPTS_FILE)
                .unwrap()
                .expect("shared file exists");
        assert_eq!(shared.prompts.len(), 1);
        assert_eq!(shared.prompts[0].id, p.id);
    }

    /// v1.52.0: demote a shared prompt back into personal. Inverse of
    /// promote. The shared file is removed entirely if it was the
    /// only entry.
    #[test]
    fn demote_to_personal_inverses_promote_and_prunes_empty_file() {
        let tmp_app = tempdir().unwrap();
        let tmp_proj = tempdir().unwrap();
        let store = PromptsStore::new(tmp_app.path().to_path_buf()).unwrap();
        let p = store
            .create(sample("round-trip"), Some("alice@x.com".into()))
            .unwrap();
        store.promote_to_shared(&p.id, tmp_proj.path()).unwrap();
        let demoted = store.demote_to_personal(&p.id, tmp_proj.path()).unwrap();
        assert_eq!(demoted.scope, LibraryScope::Personal);
        // Personal layer has it back.
        let personal = store.list().unwrap();
        assert!(personal.iter().any(|x| x.id == p.id));
        // Shared file removed (it was the only entry).
        assert!(read_library_file::<PromptsFile>(Some(tmp_proj.path()), SHARED_PROMPTS_FILE)
            .unwrap()
            .is_none());
    }

    /// v1.52.0: fork a shared prompt into a personal copy with a fresh
    /// id. Shared entry stays; personal gets a new entry stamped with
    /// the forker's identity.
    #[test]
    fn fork_to_personal_creates_independent_copy() {
        let tmp_app = tempdir().unwrap();
        let tmp_proj = tempdir().unwrap();
        let store = PromptsStore::new(tmp_app.path().to_path_buf()).unwrap();
        let p = store.create(sample("source"), Some("alice@x.com".into())).unwrap();
        store.promote_to_shared(&p.id, tmp_proj.path()).unwrap();
        let fork = store
            .fork_to_personal(&p.id, tmp_proj.path(), Some("bob@x.com".into()))
            .unwrap();
        assert_ne!(fork.id, p.id);
        assert!(fork.name.ends_with("(fork)"));
        assert_eq!(fork.author.as_deref(), Some("bob@x.com"));
        // Shared entry untouched.
        let shared: PromptsFile =
            read_library_file(Some(tmp_proj.path()), SHARED_PROMPTS_FILE)
                .unwrap()
                .expect("shared file still exists");
        assert_eq!(shared.prompts.len(), 1);
        assert_eq!(shared.prompts[0].id, p.id);
        // Personal contains the fork.
        let personal = store.list().unwrap();
        assert!(personal.iter().any(|x| x.id == fork.id));
    }

    /// v1.54.0: a pre-v1.54 shared file named `library.json` is
    /// migrated to `prompts.json` on first read, contents preserved,
    /// and the legacy file removed.
    #[test]
    fn shared_library_json_migrates_to_prompts_json_on_read() {
        let tmp_app = tempdir().unwrap();
        let tmp_proj = tempdir().unwrap();
        let store = PromptsStore::new(tmp_app.path().to_path_buf()).unwrap();
        // Seed a legacy library.json (the v1.50–v1.53 shared name).
        let legacy_path = tmp_proj
            .path()
            .join(".atelier/library")
            .join(LEGACY_SHARED_PROMPTS_FILE);
        fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        fs::write(
            &legacy_path,
            br#"{
                "version": 1,
                "prompts": [{
                    "id": "legacy-1",
                    "name": "Legacy Shared",
                    "description": "",
                    "systemPrompt": "x",
                    "promptTemplate": "y",
                    "tags": [],
                    "createdAt": 1700000000000,
                    "updatedAt": 1700000000000
                }]
            }"#,
        )
        .unwrap();
        let loaded = store
            .list_all_with_shared(Some(tmp_proj.path()))
            .unwrap();
        // The legacy prompt is visible, tagged Shared.
        let legacy = loaded
            .iter()
            .find(|p| p.id == "legacy-1")
            .expect("legacy prompt surfaced");
        assert_eq!(legacy.scope, LibraryScope::Shared);
        // Migration happened: prompts.json now exists, library.json gone.
        let new_path = tmp_proj
            .path()
            .join(".atelier/library")
            .join(SHARED_PROMPTS_FILE);
        assert!(new_path.exists(), "prompts.json written");
        assert!(!legacy_path.exists(), "legacy library.json removed");
    }

    /// v1.50.0: a malformed `.atelier/library/prompts.json` degrades to
    /// personal-only with a warn log; never crashes the store.
    #[test]
    fn list_all_with_shared_recovers_from_malformed_shared_file() {
        let tmp_app = tempdir().unwrap();
        let tmp_proj = tempdir().unwrap();
        let store = PromptsStore::new(tmp_app.path().to_path_buf()).unwrap();
        store.create(sample("only-personal"), None).unwrap();
        let shared_path = tmp_proj
            .path()
            .join(".atelier/library")
            .join(SHARED_PROMPTS_FILE);
        fs::create_dir_all(shared_path.parent().unwrap()).unwrap();
        fs::write(&shared_path, b"{ this is not json").unwrap();
        let loaded = store
            .list_all_with_shared(Some(tmp_proj.path()))
            .unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "only-personal");
        assert_eq!(loaded[0].scope, LibraryScope::Personal);
    }

    /// v1.49.0: `create()` stamps both `author` and `lastEditedBy` from the
    /// supplied email. `update()` preserves the original `author` and only
    /// rewrites `lastEditedBy`.
    #[test]
    fn create_and_update_stamp_provenance() {
        let tmp = tempdir().unwrap();
        let store = PromptsStore::new(tmp.path().to_path_buf()).unwrap();
        let p = store
            .create(sample("p"), Some("alice@example.com".into()))
            .unwrap();
        assert_eq!(p.author.as_deref(), Some("alice@example.com"));
        assert_eq!(p.last_edited_by.as_deref(), Some("alice@example.com"));
        std::thread::sleep(std::time::Duration::from_millis(2));
        let mut edited = p.clone();
        edited.name = "renamed".into();
        let updated = store
            .update(edited, Some("bob@example.com".into()))
            .unwrap();
        assert_eq!(
            updated.author.as_deref(),
            Some("alice@example.com"),
            "author preserved from create"
        );
        assert_eq!(
            updated.last_edited_by.as_deref(),
            Some("bob@example.com"),
            "lastEditedBy rewrites on update"
        );
    }

    #[test]
    fn delete_unknown_id_is_error() {
        let tmp = tempdir().unwrap();
        let store = PromptsStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(store.delete("bogus").is_err());
    }

    #[test]
    fn unknown_version_returns_empty() {
        let tmp = tempdir().unwrap();
        let store = PromptsStore::new(tmp.path().to_path_buf()).unwrap();
        let path = tmp.path().join(PROMPTS_SUBDIR).join(PROMPTS_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"version":99,"prompts":[]}"#).unwrap();
        let loaded = store.list().unwrap();
        assert!(loaded.is_empty());
    }
}
