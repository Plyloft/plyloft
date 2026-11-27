//! User-defined workspace templates — supplement the built-in `WORKSPACE_TEMPLATES`
//! constant in `src/lib/workspaceTemplates.ts`. Persisted as a single flat file
//! at `<config_dir>/templates.json`. Atomic writes (Hard Rule #3); schema
//! versioned for future migration.
//!
//! v0.8.0: introduced.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::shared_library::{
    delete_library_file, read_library_file, write_library_file, LibraryScope,
};

const TEMPLATES_FILE: &str = "templates.json";
const TEMPLATES_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TileSeedKind {
    Shell,
    Claude,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileSeed {
    pub kind: TileSeedKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTemplate {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tiles: Vec<TileSeed>,
    pub created_at: i64,
    pub updated_at: i64,
    /// v1.49.0 (Team Mode Phase 0): provenance — see prompts.rs for the
    /// full pattern. `author` is set once on create; `lastEditedBy` is
    /// rewritten on every update. Both are `None` on legacy rows.
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub last_edited_by: Option<String>,
    /// v1.51.0 (Team Mode Phase 2.2): runtime-only scope tag. Same
    /// pattern as `Prompt.scope` (v1.50.0); see that struct for the
    /// full contract.
    #[serde(default = "default_user_template_scope", skip_serializing)]
    pub scope: LibraryScope,
}

fn default_user_template_scope() -> LibraryScope {
    LibraryScope::Personal
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatesFile {
    pub version: u32,
    #[serde(default)]
    pub templates: Vec<UserTemplate>,
}

impl Default for TemplatesFile {
    fn default() -> Self {
        Self {
            version: TEMPLATES_SCHEMA_VERSION,
            templates: Vec::new(),
        }
    }
}

pub struct TemplatesStore {
    path: PathBuf,
    cache: Mutex<Vec<UserTemplate>>,
    loaded: Mutex<bool>,
}

impl TemplatesStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&config_dir).map_err(|e| format!("create config dir: {e}"))?;
        Ok(Self {
            path: config_dir.join(TEMPLATES_FILE),
            cache: Mutex::new(Vec::new()),
            loaded: Mutex::new(false),
        })
    }

    pub fn list(&self) -> Result<Vec<UserTemplate>, String> {
        if *self.loaded.lock() {
            return Ok(self.cache.lock().clone());
        }
        let templates = if self.path.exists() {
            let bytes = fs::read(&self.path).map_err(|e| format!("read templates: {e}"))?;
            if bytes.is_empty() {
                Vec::new()
            } else {
                let parsed: TemplatesFile = match serde_json::from_slice(&bytes) {
                    Ok(p) => p,
                    Err(e) => {
                        log::error!("templates: parse failed ({e}); returning empty");
                        return Ok(Vec::new());
                    }
                };
                if parsed.version != TEMPLATES_SCHEMA_VERSION {
                    log::warn!(
                        "templates: file has version {} (expected {}); ignoring",
                        parsed.version,
                        TEMPLATES_SCHEMA_VERSION
                    );
                    return Ok(Vec::new());
                }
                parsed.templates
            }
        } else {
            Vec::new()
        };
        *self.cache.lock() = templates.clone();
        *self.loaded.lock() = true;
        Ok(templates)
    }

    fn save_all(&self, templates: Vec<UserTemplate>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
        }
        let file = TemplatesFile {
            version: TEMPLATES_SCHEMA_VERSION,
            templates: templates.clone(),
        };
        let json = serde_json::to_vec_pretty(&file).map_err(|e| format!("encode: {e}"))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| format!("write tmp: {e}"))?;
        crate::platform::rename(&tmp, &self.path).map_err(|e| format!("rename: {e}"))?;
        *self.cache.lock() = templates;
        *self.loaded.lock() = true;
        Ok(())
    }

    pub fn create(
        &self,
        mut template: UserTemplate,
        author_email: Option<String>,
    ) -> Result<UserTemplate, String> {
        let now = chrono::Utc::now().timestamp_millis();
        template.id = uuid::Uuid::new_v4().to_string();
        template.created_at = now;
        template.updated_at = now;
        // v1.49.0: provenance stamps.
        template.author = author_email.clone();
        template.last_edited_by = author_email;
        let mut templates = self.list()?;
        templates.push(template.clone());
        self.save_all(templates)?;
        Ok(template)
    }

    pub fn update(
        &self,
        mut template: UserTemplate,
        author_email: Option<String>,
    ) -> Result<UserTemplate, String> {
        let now = chrono::Utc::now().timestamp_millis();
        template.updated_at = now;
        let mut templates = self.list()?;
        let idx = templates
            .iter()
            .position(|t| t.id == template.id)
            .ok_or_else(|| format!("template not found: {}", template.id))?;
        template.created_at = templates[idx].created_at;
        // v1.49.0: preserve original author; rewrite lastEditedBy.
        template.author = templates[idx].author.clone();
        template.last_edited_by = author_email;
        templates[idx] = template.clone();
        self.save_all(templates)?;
        Ok(template)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut templates = self.list()?;
        let before = templates.len();
        templates.retain(|t| t.id != id);
        if templates.len() == before {
            return Err(format!("template not found: {id}"));
        }
        self.save_all(templates)
    }

    /// v1.52.0 (Team Mode Phase 2.3): promote a personal user-template
    /// to the shared overlay at `<project_cwd>/.atelier/library/templates.json`.
    /// Same pattern as prompts/swarm-templates.
    pub fn promote_to_shared(
        &self,
        id: &str,
        project_cwd: &Path,
    ) -> Result<UserTemplate, String> {
        let mut personal = self.list()?;
        let idx = personal
            .iter()
            .position(|t| t.id == id)
            .ok_or_else(|| format!("user template not found in personal: {id}"))?;
        let mut promoted = personal.remove(idx);
        promoted.scope = LibraryScope::Personal;
        let mut shared: TemplatesFile = match read_library_file(
            Some(project_cwd),
            TEMPLATES_FILE,
        )? {
            Some(s) => s,
            None => TemplatesFile::default(),
        };
        shared.templates.retain(|t| t.id != id);
        shared.templates.push(promoted.clone());
        write_library_file(project_cwd, TEMPLATES_FILE, &shared)?;
        self.save_all(personal)?;
        promoted.scope = LibraryScope::Shared;
        Ok(promoted)
    }

    /// v1.52.0: demote a shared user-template back into the personal
    /// layer. Removes the shared file if it becomes empty.
    pub fn demote_to_personal(
        &self,
        id: &str,
        project_cwd: &Path,
    ) -> Result<UserTemplate, String> {
        let mut shared: TemplatesFile = read_library_file(
            Some(project_cwd),
            TEMPLATES_FILE,
        )?
        .ok_or_else(|| {
            "no shared library at <cwd>/.atelier/library/templates.json".to_string()
        })?;
        let idx = shared
            .templates
            .iter()
            .position(|t| t.id == id)
            .ok_or_else(|| format!("user template not found in shared: {id}"))?;
        let mut demoted = shared.templates.remove(idx);
        if shared.templates.is_empty() {
            delete_library_file(project_cwd, TEMPLATES_FILE)?;
        } else {
            write_library_file(project_cwd, TEMPLATES_FILE, &shared)?;
        }
        let mut personal = self.list()?;
        personal.retain(|t| t.id != id);
        demoted.scope = LibraryScope::Personal;
        personal.push(demoted.clone());
        self.save_all(personal)?;
        Ok(demoted)
    }

    /// v1.52.0: fork a shared user-template into a personal copy with
    /// a fresh id. Stamps the forker's email.
    pub fn fork_to_personal(
        &self,
        id: &str,
        project_cwd: &Path,
        author_email: Option<String>,
    ) -> Result<UserTemplate, String> {
        let shared: TemplatesFile = read_library_file(
            Some(project_cwd),
            TEMPLATES_FILE,
        )?
        .ok_or_else(|| {
            "no shared library at <cwd>/.atelier/library/templates.json".to_string()
        })?;
        let source = shared
            .templates
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("user template not found in shared: {id}"))?
            .clone();
        let mut fork = source;
        fork.id = String::new();
        fork.label = format!("{} (fork)", fork.label);
        self.create(fork, author_email)
    }

    /// v1.51.0 (Team Mode Phase 2.2): return personal templates tagged
    /// `Personal`, optionally merged with shared templates from
    /// `<project_cwd>/.atelier/library/templates.json` tagged `Shared`.
    /// Same merge policy as `PromptsStore::list_all_with_shared`.
    pub fn list_all_with_shared(
        &self,
        project_cwd: Option<&Path>,
    ) -> Result<Vec<UserTemplate>, String> {
        let mut personal = self.list()?;
        for t in personal.iter_mut() {
            t.scope = LibraryScope::Personal;
        }
        let shared: Option<TemplatesFile> =
            match read_library_file(project_cwd, TEMPLATES_FILE) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!(
                        "templates: shared library read failed ({e}); using personal only"
                    );
                    None
                }
            };
        let Some(shared) = shared else {
            return Ok(personal);
        };
        if shared.version != TEMPLATES_SCHEMA_VERSION {
            log::warn!(
                "templates: shared library has version {} (expected {}); using personal only",
                shared.version,
                TEMPLATES_SCHEMA_VERSION
            );
            return Ok(personal);
        }
        let shared_ids: std::collections::HashSet<&str> =
            shared.templates.iter().map(|t| t.id.as_str()).collect();
        personal.retain(|t| !shared_ids.contains(t.id.as_str()));
        for mut s in shared.templates {
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

    fn sample(label: &str, n_shell: usize, n_claude: usize) -> UserTemplate {
        let mut tiles = Vec::new();
        for _ in 0..n_shell {
            tiles.push(TileSeed { kind: TileSeedKind::Shell });
        }
        for _ in 0..n_claude {
            tiles.push(TileSeed { kind: TileSeedKind::Claude });
        }
        UserTemplate {
            id: String::new(),
            label: label.into(),
            description: String::new(),
            tiles,
            created_at: 0,
            updated_at: 0,
            author: None,
            last_edited_by: None,
            scope: LibraryScope::Personal,
        }
    }

    #[test]
    fn create_then_list_round_trips() {
        let tmp = tempdir().unwrap();
        let store = TemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        let t = store.create(sample("Reviewer", 1, 2), None).unwrap();
        assert!(!t.id.is_empty());
        let s2 = TemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        let loaded = s2.list().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].label, "Reviewer");
        assert_eq!(loaded[0].tiles.len(), 3);
    }

    #[test]
    fn delete_removes_only_target() {
        let tmp = tempdir().unwrap();
        let store = TemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        let a = store.create(sample("a", 0, 1), None).unwrap();
        let _b = store.create(sample("b", 1, 0), None).unwrap();
        store.delete(&a.id).unwrap();
        let loaded = store.list().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].label, "b");
    }

    /// v1.49.0 Tier 2 (Team Mode Phase 0): legacy templates.json without
    /// `author` / `lastEditedBy` loads with both defaulting to None.
    #[test]
    fn legacy_user_templates_load_with_provenance_none() {
        let pre_team_json = br#"{
            "version": 1,
            "templates": [{
                "id": "abc",
                "label": "Legacy",
                "tiles": [],
                "createdAt": 1700000000000,
                "updatedAt": 1700000000000
            }]
        }"#;
        let parsed: TemplatesFile = serde_json::from_slice(pre_team_json).expect("parse");
        assert_eq!(parsed.templates.len(), 1);
        assert_eq!(parsed.templates[0].author, None);
        assert_eq!(parsed.templates[0].last_edited_by, None);
    }

    /// v1.51.0 (Team Mode Phase 2.2): `list_all_with_shared(None)` returns
    /// personal-only, every entry tagged `Personal`.
    #[test]
    fn list_all_with_shared_none_returns_personal_only() {
        let tmp = tempdir().unwrap();
        let store = TemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        store.create(sample("t", 1, 1), None).unwrap();
        let loaded = store.list_all_with_shared(None).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].scope, LibraryScope::Personal);
    }

    /// v1.51.0: shared user templates from
    /// `<cwd>/.atelier/library/templates.json` merge in tagged Shared;
    /// id collisions resolve to the shared entry.
    #[test]
    fn list_all_with_shared_merges_repo_library() {
        let tmp_app = tempdir().unwrap();
        let tmp_proj = tempdir().unwrap();
        let store = TemplatesStore::new(tmp_app.path().to_path_buf()).unwrap();
        store.create(sample("only-personal", 1, 0), None).unwrap();
        let colliding = store
            .create(sample("personal-colliding", 0, 1), None)
            .unwrap();
        let shared_path = tmp_proj.path().join(".atelier/library").join(TEMPLATES_FILE);
        fs::create_dir_all(shared_path.parent().unwrap()).unwrap();
        let shared_json = format!(
            r#"{{
                "version": 1,
                "templates": [
                    {{
                        "id": "shared-only",
                        "label": "Shared",
                        "description": "",
                        "tiles": [{{"kind":"claude"}}],
                        "createdAt": 1700000000000,
                        "updatedAt": 1700000000000
                    }},
                    {{
                        "id": "{}",
                        "label": "Override",
                        "description": "",
                        "tiles": [],
                        "createdAt": 1700000000000,
                        "updatedAt": 1700000000000
                    }}
                ]
            }}"#,
            colliding.id
        );
        fs::write(&shared_path, shared_json).unwrap();
        let loaded = store
            .list_all_with_shared(Some(tmp_proj.path()))
            .unwrap();
        assert_eq!(loaded.len(), 3);
        let shared_only = loaded
            .iter()
            .find(|t| t.id == "shared-only")
            .expect("shared-only present");
        assert_eq!(shared_only.scope, LibraryScope::Shared);
        let override_entry = loaded
            .iter()
            .find(|t| t.id == colliding.id)
            .expect("override present");
        assert_eq!(override_entry.scope, LibraryScope::Shared);
        assert_eq!(override_entry.label, "Override");
    }

    /// v1.49.0: create stamps both; update preserves author and rewrites
    /// lastEditedBy.
    #[test]
    fn user_template_create_and_update_stamp_provenance() {
        let tmp = tempdir().unwrap();
        let store = TemplatesStore::new(tmp.path().to_path_buf()).unwrap();
        let t = store
            .create(sample("t", 1, 1), Some("alice@x.com".into()))
            .unwrap();
        assert_eq!(t.author.as_deref(), Some("alice@x.com"));
        assert_eq!(t.last_edited_by.as_deref(), Some("alice@x.com"));
        std::thread::sleep(std::time::Duration::from_millis(2));
        let mut edited = t.clone();
        edited.label = "renamed".into();
        let updated = store.update(edited, Some("bob@x.com".into())).unwrap();
        assert_eq!(updated.author.as_deref(), Some("alice@x.com"));
        assert_eq!(updated.last_edited_by.as_deref(), Some("bob@x.com"));
    }
}
