//! Shared, read-only Knowledge core for Ply.
//!
//! This crate owns the accepted-Knowledge data model, markdown/frontmatter
//! codec, canonical paths, lexical ranking, and stateless disk reader used by
//! both the Tauri host and `ply-mcp`.
//!
//! Deliberately absent: filesystem writes and Knowledge mutations. The Tauri
//! host retains create/update/delete/promote/demote/fork plus atomic writes.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};

mod evidence;

pub use evidence::*;

pub const MEMORY_SUBDIR: &str = "memory";
pub const WORKSPACES_DIR: &str = "workspaces";
pub const GLOBAL_DIR: &str = "global";
/// The Project scope's on-repo home. v1.115.0 relabels this layer Team →
/// **Project** everywhere it reaches a human; the path is untouched, so no
/// entry moves and no migration runs.
pub const SHARED_KNOWLEDGE_DIR: &str = ".atelier/library/knowledge";
/// The Team scope's home *inside a team-repo clone*
/// (`<app-support>/team/<slug>/`). v1.115.0 (team sharing rung 2).
pub const TEAM_KNOWLEDGE_SUBDIR: &str = "library/knowledge";
pub const MEMORY_SCHEMA_VERSION: u32 = 1;
pub const SLUG_MAX_LEN: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryScope {
    Workspace,
    Global,
}

/// v1.115.0 (team sharing rung 2): which of the two Knowledge axes an entry
/// sits on, flattened to the three homes an entry can actually have.
///
/// The panel presents the same information as *Personal / Shared* ×
/// *Project / Everywhere*: `Personal` covers both personal scopes (the
/// [`MemoryScope`] field says which), `Project` is the repo's committed
/// layer and `Team` is the team library shared across every project.
///
/// Derived at read time from the directory an entry was read out of — it is
/// never written into the frontmatter, so moving a file between layers is
/// the whole of a promote or a demote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum KnowledgeLayer {
    #[default]
    Personal,
    Project,
    Team,
}

impl KnowledgeLayer {
    /// The pre-v1.115.0 wire field: any layer other than `Personal` was
    /// `shared: true`. Kept so an older reader (and every existing caller)
    /// still gets a truthful answer to "is this entry shared".
    pub fn is_shared(self) -> bool {
        !matches!(self, Self::Personal)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MemorySource {
    Suggested {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        card_id: Option<String>,
    },
    Manual,
}

impl Default for MemorySource {
    fn default() -> Self {
        Self::Manual
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum KnowledgeType {
    #[default]
    Note,
    Prompt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frontmatter {
    schema_version: u32,
    id: String,
    title: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    linked_cards: Vec<String>,
    #[serde(default)]
    source: MemorySource,
    #[serde(default)]
    entry_type: KnowledgeType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt_template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    evidence: Option<KnowledgeEvidenceEnvelope>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub scope: MemoryScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub linked_cards: Vec<String>,
    #[serde(default)]
    pub source: MemorySource,
    #[serde(default)]
    pub entry_type: KnowledgeType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_template: Option<String>,
    /// `layer != Personal`. Retained for every caller written before the
    /// Team layer existed; [`Memory::layer`] is the field that distinguishes
    /// Project from Team.
    #[serde(default)]
    pub shared: bool,
    #[serde(default)]
    pub layer: KnowledgeLayer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<KnowledgeEvidenceEnvelope>,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn memory_root(config_dir: &Path) -> PathBuf {
    config_dir.join(MEMORY_SUBDIR)
}

pub fn scope_dir(
    root: &Path,
    scope: MemoryScope,
    workspace_id: Option<&str>,
) -> Result<PathBuf, String> {
    match scope {
        MemoryScope::Workspace => {
            let id =
                workspace_id.ok_or_else(|| "workspace scope requires workspaceId".to_string())?;
            if id.is_empty() {
                return Err("workspaceId is empty".into());
            }
            Ok(root.join(WORKSPACES_DIR).join(id))
        }
        MemoryScope::Global => Ok(root.join(GLOBAL_DIR)),
    }
}

/// The Project layer's directory inside a workspace checkout.
pub fn shared_knowledge_dir(project_cwd: &Path) -> PathBuf {
    project_cwd.join(SHARED_KNOWLEDGE_DIR)
}

/// GH #82: a shared workspace's copy of the integration branch's shared
/// library, kept by Ply per Mac at `<config>/projects/<ws>/shared_library/`.
/// It mirrors the repository's layout (`.atelier/library/knowledge/`,
/// `.claude/skills/`), read from the fetched tip with this Mac's queued
/// changes laid over it — never from the checkout.
pub const SHARED_LIBRARY_MIRROR_DIR: &str = "shared_library";
/// Written last when a mirror is built; a mirror without it is not used.
pub const SHARED_LIBRARY_MANIFEST: &str = "manifest.json";

pub fn shared_library_mirror(config_dir: &Path, workspace_id: &str) -> PathBuf {
    config_dir
        .join("projects")
        .join(workspace_id)
        .join(SHARED_LIBRARY_MIRROR_DIR)
}

/// The build a mirror link points at, read through once: builds are never
/// renamed, so a reader holding this path is untouched by the next swap (a
/// lookup through the link while it is being replaced can fail for a moment
/// on macOS, hence the retries). A plain directory is its own build.
pub fn resolve_mirror(mirror: &Path) -> Option<PathBuf> {
    for _ in 0..5 {
        match fs::symlink_metadata(mirror) {
            Ok(meta) if meta.file_type().is_symlink() => {
                if let Ok(target) = fs::read_link(mirror) {
                    // A junction reads back as `\\?\C:\...`; the plain form
                    // is what the rest of Ply compares against.
                    #[cfg(windows)]
                    let target = dunce::simplified(&target).to_path_buf();
                    let target = if target.is_absolute() {
                        target
                    } else {
                        mirror.parent().map(|p| p.join(&target)).unwrap_or(target)
                    };
                    if target.join(SHARED_LIBRARY_MANIFEST).is_file() {
                        return Some(target);
                    }
                }
            }
            Ok(meta) if meta.is_dir() => {
                return mirror.join(SHARED_LIBRARY_MANIFEST).is_file().then(|| mirror.to_path_buf());
            }
            Ok(_) => return None,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(_) => {}
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    None
}

/// The directory whose `.atelier/library/knowledge/` is a workspace's
/// Project layer: its mirror's current build once one exists, else the
/// checkout (a workspace with no shared definition keeps reading its checkout).
pub fn project_layer_root(
    config_dir: &Path,
    workspace_id: Option<&str>,
    project_cwd: &Path,
) -> PathBuf {
    if let Some(workspace_id) = workspace_id.filter(|id| validate_workspace_id(id).is_ok()) {
        if let Some(build) = resolve_mirror(&shared_library_mirror(config_dir, workspace_id)) {
            return build;
        }
    }
    project_cwd.to_path_buf()
}

/// [`project_layer_root`] when only the checkout is known: the mirror of a
/// workspace in `workspaces.json` whose checkout is `project_cwd`, else the
/// checkout. Only live workspaces count — a removed workspace's leftover
/// `projects/<id>/` is never read, so re-adding a folder reads the new
/// workspace's mirror, as the sidecar (selecting by id) does.
pub fn project_layer_root_for_cwd(config_dir: &Path, project_cwd: &Path) -> PathBuf {
    let canonical = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let wanted = canonical(project_cwd);
    let Ok(bytes) = fs::read(config_dir.join("workspaces.json")) else {
        return project_cwd.to_path_buf();
    };
    let Ok(file) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return project_cwd.to_path_buf();
    };
    let workspaces = file
        .get("workspaces")
        .and_then(|w| w.as_array())
        .cloned()
        .unwrap_or_default();
    for workspace in workspaces {
        let (Some(id), Some(cwd)) = (
            workspace.get("id").and_then(|v| v.as_str()),
            workspace.get("cwd").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        if canonical(Path::new(cwd)) != wanted {
            continue;
        }
        let root = project_layer_root(config_dir, Some(id), project_cwd);
        if root != project_cwd {
            return root;
        }
    }
    project_cwd.to_path_buf()
}

/// The Team layer's directory inside a team-repo clone. `team_clone_dir` is
/// `<app-support>/team/<slug>/` — the clone `team::TeamStore` owns, never a
/// workspace.
pub fn team_knowledge_dir(team_clone_dir: &Path) -> PathBuf {
    team_clone_dir.join(TEAM_KNOWLEDGE_SUBDIR)
}

pub fn read_scope(
    root: &Path,
    scope: MemoryScope,
    workspace_id: Option<&str>,
) -> Result<Vec<Memory>, String> {
    let dir = scope_dir(root, scope, workspace_id)?;
    // Preserve the Tauri store's existing behavior: a missing path or a path
    // that is not a directory represents an empty scope.
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    read_existing_dir(&dir, scope, workspace_id, KnowledgeLayer::Personal)
}

/// Read the Project layer out of a workspace checkout.
pub fn read_shared(project_cwd: &Path) -> Result<Vec<Memory>, String> {
    read_shared_layer(&shared_knowledge_dir(project_cwd), KnowledgeLayer::Project)
}

/// Read the Team layer out of a team-repo clone. Same tolerance as the
/// Project layer: a machine with no team clone simply has no Team entries.
pub fn read_team(team_clone_dir: &Path) -> Result<Vec<Memory>, String> {
    read_shared_layer(&team_knowledge_dir(team_clone_dir), KnowledgeLayer::Team)
}

fn read_shared_layer(dir: &Path, layer: KnowledgeLayer) -> Result<Vec<Memory>, String> {
    // Preserve the host's existing shared-layer behavior: failure to open the
    // directory is treated as an empty layer.
    if fs::read_dir(dir).is_err() {
        return Ok(Vec::new());
    }
    let mut items = read_existing_dir(dir, MemoryScope::Global, None, layer)?;
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

fn read_dir_strict(
    dir: &Path,
    scope: MemoryScope,
    workspace_id: Option<&str>,
    layer: KnowledgeLayer,
) -> Result<Vec<Memory>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    if !dir.is_dir() {
        return Err(format!(
            "knowledge path is not a directory: {}",
            dir.display()
        ));
    }
    read_existing_dir(dir, scope, workspace_id, layer)
}

fn read_existing_dir(
    dir: &Path,
    scope: MemoryScope,
    workspace_id: Option<&str>,
    layer: KnowledgeLayer,
) -> Result<Vec<Memory>, String> {
    let mut items = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| format!("read_dir {dir:?}: {e}"))?;
    for entry in entries {
        let entry = match entry {
            Ok(value) => value,
            Err(error) => {
                log::warn!("knowledge: skip directory entry ({error})");
                continue;
            }
        };
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let Some(slug) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        match read_memory_file(&path, scope, workspace_id, slug, layer) {
            Ok(memory) => items.push(memory),
            Err(error) => log::warn!("knowledge: skip {path:?}: {error}"),
        }
    }
    Ok(items)
}

fn read_memory_file(
    path: &Path,
    scope: MemoryScope,
    workspace_id: Option<&str>,
    slug: &str,
    layer: KnowledgeLayer,
) -> Result<Memory, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("read: {e}"))?;
    let (frontmatter, body) = parse_memory_file(&text)?;
    Ok(Memory {
        id: frontmatter.id,
        slug: slug.to_string(),
        title: frontmatter.title,
        scope,
        workspace_id: workspace_id.map(str::to_string),
        tags: frontmatter.tags,
        linked_cards: frontmatter.linked_cards,
        source: frontmatter.source,
        entry_type: frontmatter.entry_type,
        system_prompt: frontmatter.system_prompt,
        prompt_template: frontmatter.prompt_template,
        shared: layer.is_shared(),
        layer,
        evidence: frontmatter.evidence,
        body,
        created_at: frontmatter.created_at,
        updated_at: frontmatter.updated_at,
    })
}

pub fn encode_memory(memory: &Memory) -> Result<String, String> {
    let frontmatter = Frontmatter {
        schema_version: MEMORY_SCHEMA_VERSION,
        id: memory.id.clone(),
        title: memory.title.clone(),
        tags: memory.tags.clone(),
        linked_cards: memory.linked_cards.clone(),
        source: memory.source.clone(),
        entry_type: memory.entry_type,
        system_prompt: memory.system_prompt.clone(),
        prompt_template: memory.prompt_template.clone(),
        evidence: memory.evidence.clone(),
        created_at: memory.created_at.clone(),
        updated_at: memory.updated_at.clone(),
    };
    emit_memory_file(&frontmatter, &memory.body)
}

fn parse_memory_file(text: &str) -> Result<(Frontmatter, String), String> {
    let trimmed = text.trim_start_matches('\u{feff}');
    let after_first = if let Some(rest) = trimmed.strip_prefix("---\n") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("---\r\n") {
        rest
    } else {
        return Err("missing frontmatter (file must start with `---`)".into());
    };
    let (yaml_text, body_start_offset) = if let Some(index) = after_first.find("\n---\n") {
        (&after_first[..index], index + "\n---\n".len())
    } else if let Some(index) = after_first.find("\n---\r\n") {
        (&after_first[..index], index + "\n---\r\n".len())
    } else if let Some(stripped) = after_first.strip_suffix("\n---") {
        (stripped, after_first.len())
    } else {
        return Err("unterminated frontmatter (no closing `---`)".into());
    };
    let frontmatter = serde_yaml_ng::from_str(yaml_text).map_err(|e| format!("yaml parse: {e}"))?;
    let body = after_first
        .get(body_start_offset..)
        .unwrap_or("")
        .trim_start_matches('\n')
        .to_string();
    Ok((frontmatter, body))
}

fn emit_memory_file(frontmatter: &Frontmatter, body: &str) -> Result<String, String> {
    let yaml = serde_yaml_ng::to_string(frontmatter).map_err(|e| format!("yaml emit: {e}"))?;
    Ok(format!("---\n{yaml}---\n{body}"))
}

pub fn search_memories(items: &[Memory], query: &str, limit: usize) -> Vec<Memory> {
    let query = query.trim().to_lowercase();
    let terms: Vec<&str> = query
        .split_whitespace()
        .filter(|term| term.len() >= 2)
        .collect();
    let mut scored: Vec<(u8, &Memory)> = items
        .iter()
        .filter_map(|memory| {
            if terms.is_empty() {
                return Some((0, memory));
            }
            let title = memory.title.to_lowercase();
            let body = memory.body.to_lowercase();
            let mut max_tier = 0;
            for term in &terms {
                if title.contains(term) {
                    max_tier = max_tier.max(3);
                    continue;
                }
                if memory
                    .tags
                    .iter()
                    .any(|tag| tag.to_lowercase().contains(term))
                {
                    max_tier = max_tier.max(2);
                    continue;
                }
                if body.contains(term) {
                    max_tier = max_tier.max(1);
                }
            }
            (max_tier > 0).then_some((max_tier, memory))
        })
        .collect();
    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| right.1.updated_at.cmp(&left.1.updated_at))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(_, memory)| memory.clone())
        .collect()
}

pub fn slugify(title: &str) -> String {
    let mut output = String::with_capacity(title.len());
    let mut last_dash = true;
    for character in title.chars() {
        let character = character.to_ascii_lowercase();
        if character.is_ascii_alphanumeric() {
            output.push(character);
            last_dash = false;
        } else if !last_dash {
            output.push('-');
            last_dash = true;
        }
    }
    while output.ends_with('-') {
        output.pop();
    }
    if output.is_empty() {
        return "memory".to_string();
    }
    if output.len() > SLUG_MAX_LEN {
        output.truncate(SLUG_MAX_LEN);
        while output.ends_with('-') {
            output.pop();
        }
    }
    output
}

/// The slug a new note titled `title` gets in `dir`: `slugify(title)`, or that
/// base with a random suffix when a note already has it (case-insensitively).
///
/// GH #206: a directory that cannot be inspected is an error, never "no
/// collision". Guessing absence here handed a new note an existing note's
/// slug, and the write that followed replaced that note's file.
pub fn next_available_slug(dir: &Path, title: &str) -> std::io::Result<String> {
    let base = slugify(title);
    if !slug_exists_case_insensitive(dir, &base)? {
        return Ok(base);
    }
    let suffix = &uuid::Uuid::new_v4().to_string()[..8];
    let candidate = format!("{base}-{suffix}");
    if slug_exists_case_insensitive(dir, &candidate)? {
        Ok(format!("{base}-{}", uuid::Uuid::new_v4()))
    } else {
        Ok(candidate)
    }
}

/// Inspect slug collisions consistently on case-sensitive and insensitive disks.
/// Share callers must propagate inspection errors instead of assuming absence.
pub fn slug_exists_case_insensitive(dir: &Path, slug: &str) -> std::io::Result<bool> {
    let lower = slug.to_lowercase();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let mut found = false;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(stem) = name.strip_suffix(".md") else {
            continue;
        };
        found |= stem.to_lowercase() == lower;
    }
    Ok(found)
}

#[derive(Debug, Clone)]
pub struct AcceptedKnowledgeReader {
    root: PathBuf,
    /// GH #82: where the Project layer is read (the mirror or the checkout).
    config_dir: PathBuf,
    workspace_id: Option<String>,
    project_cwd: Option<PathBuf>,
    /// v1.115.0: the team-repo clone whose `library/knowledge/` is the Team
    /// layer. `None` on a machine with no team key — the other three layers
    /// are unaffected.
    team_clone_dir: Option<PathBuf>,
}

impl AcceptedKnowledgeReader {
    pub fn new(
        config_dir: PathBuf,
        workspace_id: Option<String>,
        project_cwd: Option<PathBuf>,
    ) -> Result<Self, String> {
        Self::with_team(config_dir, workspace_id, project_cwd, None)
    }

    /// v1.115.0 (team sharing rung 2): the same reader with the Team layer
    /// attached, so a Builder or Challenger session sees the team library.
    pub fn with_team(
        config_dir: PathBuf,
        workspace_id: Option<String>,
        project_cwd: Option<PathBuf>,
        team_clone_dir: Option<PathBuf>,
    ) -> Result<Self, String> {
        if let Some(id) = workspace_id.as_deref() {
            validate_workspace_id(id)?;
        }
        Ok(Self {
            root: memory_root(&config_dir),
            config_dir,
            workspace_id,
            project_cwd,
            team_clone_dir,
        })
    }

    pub fn search(
        &self,
        query: &str,
        tags: &[String],
        limit: usize,
    ) -> Result<Vec<Memory>, String> {
        let mut output = Vec::new();
        if let Some(workspace_id) = self.workspace_id.as_deref() {
            let items = filter_tags(
                read_dir_strict(
                    &scope_dir(&self.root, MemoryScope::Workspace, Some(workspace_id))?,
                    MemoryScope::Workspace,
                    Some(workspace_id),
                    KnowledgeLayer::Personal,
                )?,
                tags,
            );
            output.extend(search_memories(&items, query, limit));
        }
        if output.len() < limit {
            if let Some(project_cwd) = self.project_cwd.as_deref() {
                let items = filter_tags(
                    read_dir_strict(
                        &shared_knowledge_dir(&project_layer_root(
                            &self.config_dir,
                            self.workspace_id.as_deref(),
                            project_cwd,
                        )),
                        MemoryScope::Global,
                        None,
                        KnowledgeLayer::Project,
                    )?,
                    tags,
                );
                output.extend(search_memories(&items, query, limit - output.len()));
            }
        }
        if output.len() < limit {
            let items = filter_tags(self.team_entries(), tags);
            output.extend(search_memories(&items, query, limit - output.len()));
        }
        if output.len() < limit {
            let items = filter_tags(
                read_dir_strict(
                    &scope_dir(&self.root, MemoryScope::Global, None)?,
                    MemoryScope::Global,
                    None,
                    KnowledgeLayer::Personal,
                )?,
                tags,
            );
            output.extend(search_memories(&items, query, limit - output.len()));
        }
        output.truncate(limit);
        Ok(output)
    }

    /// The Team layer, or nothing.
    ///
    /// Unlike the member's own three layers, a failure here is logged and
    /// skipped rather than returned. The Team layer is additive and lives
    /// in a clone Ply manages: one member's damaged `library/knowledge`
    /// must not stop their session reading their own Workspace, Project
    /// and Global Knowledge. (An *absent* directory is already the empty
    /// case, so this only covers a path that exists and cannot be read —
    /// a file where a directory belongs, a permissions problem.)
    fn team_entries(&self) -> Vec<Memory> {
        let Some(team_clone_dir) = self.team_clone_dir.as_deref() else {
            return Vec::new();
        };
        let dir = team_knowledge_dir(team_clone_dir);
        match read_dir_strict(&dir, MemoryScope::Global, None, KnowledgeLayer::Team) {
            Ok(items) => items,
            Err(error) => {
                log::warn!("knowledge: team layer unavailable ({error})");
                Vec::new()
            }
        }
    }

    pub fn get(&self, id: &str) -> Result<Option<Memory>, String> {
        if id.trim().is_empty() {
            return Err("knowledge id is empty".into());
        }
        if let Some(workspace_id) = self.workspace_id.as_deref() {
            if let Some(memory) = read_dir_strict(
                &scope_dir(&self.root, MemoryScope::Workspace, Some(workspace_id))?,
                MemoryScope::Workspace,
                Some(workspace_id),
                KnowledgeLayer::Personal,
            )?
            .into_iter()
            .find(|memory| memory.id == id)
            {
                return Ok(Some(memory));
            }
        }
        if let Some(project_cwd) = self.project_cwd.as_deref() {
            if let Some(memory) = read_dir_strict(
                &shared_knowledge_dir(&project_layer_root(
                    &self.config_dir,
                    self.workspace_id.as_deref(),
                    project_cwd,
                )),
                MemoryScope::Global,
                None,
                KnowledgeLayer::Project,
            )?
            .into_iter()
            .find(|memory| memory.id == id)
            {
                return Ok(Some(memory));
            }
        }
        if let Some(memory) = self
            .team_entries()
            .into_iter()
            .find(|memory| memory.id == id)
        {
            return Ok(Some(memory));
        }
        Ok(read_dir_strict(
            &scope_dir(&self.root, MemoryScope::Global, None)?,
            MemoryScope::Global,
            None,
            KnowledgeLayer::Personal,
        )?
        .into_iter()
        .find(|memory| memory.id == id))
    }
}

fn validate_workspace_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("workspaceId is empty".into());
    }
    let mut components = Path::new(id).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err("workspaceId must be one normal path component".into()),
    }
}

fn filter_tags(items: Vec<Memory>, requested: &[String]) -> Vec<Memory> {
    let requested: Vec<String> = requested
        .iter()
        .map(|tag| tag.trim().to_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect();
    if requested.is_empty() {
        return items;
    }
    items
        .into_iter()
        .filter(|memory| {
            requested.iter().all(|requested_tag| {
                memory
                    .tags
                    .iter()
                    .any(|tag| tag.to_lowercase() == *requested_tag)
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fixture(id: &str, title: &str, body: &str, updated_at: &str) -> Memory {
        Memory {
            id: id.into(),
            slug: slugify(title),
            title: title.into(),
            scope: MemoryScope::Global,
            workspace_id: None,
            tags: vec![],
            linked_cards: vec![],
            source: MemorySource::Manual,
            entry_type: KnowledgeType::Note,
            system_prompt: None,
            prompt_template: None,
            shared: false,
            layer: KnowledgeLayer::Personal,
            evidence: None,
            body: body.into(),
            created_at: updated_at.into(),
            updated_at: updated_at.into(),
        }
    }

    fn write_fixture(path: &Path, memory: &Memory) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, encode_memory(memory).unwrap()).unwrap();
    }

    #[test]
    fn frontmatter_round_trip_is_exact() {
        let mut memory = fixture("id-1", "Hello", "Body content.", "2026-05-20T10:00:00Z");
        memory.tags = vec!["a".into(), "b".into()];
        memory.linked_cards = vec!["card-1".into()];
        memory.source = MemorySource::Suggested {
            run_id: Some("run-1".into()),
            card_id: Some("card-1".into()),
        };
        let text = encode_memory(&memory).unwrap();
        let (frontmatter, body) = parse_memory_file(&text).unwrap();
        assert_eq!(frontmatter.id, "id-1");
        assert_eq!(frontmatter.tags, vec!["a", "b"]);
        assert_eq!(body, "Body content.");
        assert_eq!(encode_memory(&memory).unwrap(), text);
    }

    #[test]
    fn legacy_minimal_frontmatter_loads_defaults() {
        let text = include_str!("../tests/fixtures/legacy-minimal.md");
        let (frontmatter, body) = parse_memory_file(text).unwrap();
        assert!(frontmatter.tags.is_empty());
        assert!(frontmatter.linked_cards.is_empty());
        assert_eq!(frontmatter.source, MemorySource::Manual);
        assert_eq!(frontmatter.entry_type, KnowledgeType::Note);
        assert!(frontmatter.evidence.is_none());
        assert_eq!(body.trim_end(), "body");
        let memory = Memory {
            id: frontmatter.id,
            slug: "legacy".into(),
            title: frontmatter.title,
            scope: MemoryScope::Global,
            workspace_id: None,
            tags: frontmatter.tags,
            linked_cards: frontmatter.linked_cards,
            source: frontmatter.source,
            entry_type: frontmatter.entry_type,
            system_prompt: frontmatter.system_prompt,
            prompt_template: frontmatter.prompt_template,
            shared: false,
            layer: KnowledgeLayer::Personal,
            evidence: frontmatter.evidence,
            body,
            created_at: frontmatter.created_at,
            updated_at: frontmatter.updated_at,
        };
        assert!(
            !encode_memory(&memory).unwrap().contains("\nevidence:"),
            "legacy Markdown must not acquire invented provenance"
        );
    }

    #[test]
    fn adversarial_evidence_frontmatter_round_trips_without_delimiter_or_utf8_loss() {
        let mut source = b"first\r\n---\r\ninvalid: ".to_vec();
        source.extend_from_slice(&[0xf0, 0x28, 0x8c, 0x28]);
        source.extend_from_slice(b"\r\n");
        source.extend(std::iter::repeat_n(b'x', 12_000));
        let excerpt = bounded_lossy_text(&source, MAX_ACCEPTED_DIFF_EXCERPT_BYTES);
        assert!(excerpt.lossy);
        assert!(!excerpt.truncated);

        let mut memory = fixture(
            "evidence-id",
            "Adversarial evidence",
            "Markdown body\n---\nstays body",
            "2026-07-26T10:00:00Z",
        );
        memory.evidence = Some(KnowledgeEvidenceEnvelope {
            schema_version: EVIDENCE_SCHEMA_VERSION,
            proposal_id: "kp-adversarial".into(),
            suggestion_id: Some("kps-adversarial".into()),
            landed_diff: DiffEvidence {
                sha256: sha256_hex(&source),
                byte_count: source.len() as u64,
                changed_paths: vec![ChangedPathEvidence {
                    path: "src/adversarial.rs".into(),
                    status: EvidencePathStatus::Modified,
                    lossy: true,
                    ..ChangedPathEvidence::default()
                }],
                changed_path_count: 1,
                excerpt: Some(excerpt.text),
                excerpt_byte_count: source.len() as u64,
                excerpt_truncated: false,
                ..DiffEvidence::default()
            },
            verification_artifacts: vec![VerificationArtifactEvidence {
                verify_run_id: "verify-opaque".into(),
                status: "passed".into(),
                ..VerificationArtifactEvidence::default()
            }],
            reviewer_artifacts: vec![ReviewerArtifactEvidence {
                review_id: "review-artifact-opaque".into(),
                provider: "claude".into(),
                ..ReviewerArtifactEvidence::default()
            }],
            discussion_artifacts: vec![DiscussionArtifactEvidence {
                discussion_id: "discussion-artifact-opaque".into(),
                pinned_revision: "pinned".into(),
                ..DiscussionArtifactEvidence::default()
            }],
            handoff_artifacts: vec![HandoffArtifactEvidence {
                handoff_id: "handoff-opaque".into(),
                ..HandoffArtifactEvidence::default()
            }],
            ids: EvidenceIdentifiers {
                card_ids: vec!["card-opaque".into()],
                run_ids: vec!["run-opaque".into()],
                swarm_ids: vec!["swarm-opaque".into()],
                session_ids: vec!["session-opaque".into()],
                ..EvidenceIdentifiers::default()
            },
            ..KnowledgeEvidenceEnvelope::default()
        });

        let encoded = encode_memory(&memory).unwrap();
        let (frontmatter, body) = parse_memory_file(&encoded).unwrap();
        assert_eq!(frontmatter.evidence, memory.evidence);
        assert_eq!(body, memory.body);
        assert_eq!(encode_memory(&memory).unwrap(), encoded);
    }

    #[test]
    fn frontmatter_handles_bom_and_crlf() {
        let text = "\u{feff}---\r\nschemaVersion: 1\r\nid: cr\r\ntitle: t\r\ncreatedAt: '2026-05-20T10:00:00Z'\r\nupdatedAt: '2026-05-20T10:00:00Z'\r\n---\r\nbody";
        let (frontmatter, body) = parse_memory_file(text).unwrap();
        assert_eq!(frontmatter.id, "cr");
        assert_eq!(body, "body");
    }

    #[test]
    fn malformed_frontmatter_fails() {
        assert!(parse_memory_file("no frontmatter").is_err());
        assert!(parse_memory_file("---\nid: no closing fence").is_err());
    }

    #[test]
    fn lexical_ranking_matches_title_then_tag_then_body() {
        let mut title = fixture("title", "alpha title", "none", "2026-01-01T00:00:00Z");
        let mut tag = fixture("tag", "other", "none", "2026-01-02T00:00:00Z");
        let body = fixture("body", "other", "alpha body", "2026-01-03T00:00:00Z");
        title.tags = vec![];
        tag.tags = vec!["alpha-tag".into()];
        let hits = search_memories(&[body, tag, title], "alpha", 10);
        assert_eq!(
            hits.iter()
                .map(|memory| memory.id.as_str())
                .collect::<Vec<_>>(),
            vec!["title", "tag", "body"]
        );
    }

    #[test]
    fn reader_layer_order_tags_and_get_are_stable() {
        let config = tempdir().unwrap();
        let project = tempdir().unwrap();
        let root = memory_root(config.path());

        let mut workspace = fixture(
            "workspace",
            "auth workspace",
            "body",
            "2026-01-01T00:00:00Z",
        );
        workspace.scope = MemoryScope::Workspace;
        workspace.workspace_id = Some("ws-1".into());
        workspace.tags = vec!["rust".into(), "auth".into()];
        write_fixture(
            &root.join(WORKSPACES_DIR).join("ws-1").join("workspace.md"),
            &workspace,
        );

        let mut shared = fixture("shared", "auth shared", "body", "2026-01-03T00:00:00Z");
        shared.shared = true;
        shared.tags = vec!["rust".into(), "auth".into()];
        write_fixture(
            &shared_knowledge_dir(project.path()).join("shared.md"),
            &shared,
        );

        let mut global = fixture("global", "auth global", "body", "2026-01-04T00:00:00Z");
        global.tags = vec!["rust".into()];
        write_fixture(&root.join(GLOBAL_DIR).join("global.md"), &global);

        let reader = AcceptedKnowledgeReader::new(
            config.path().to_path_buf(),
            Some("ws-1".into()),
            Some(project.path().to_path_buf()),
        )
        .unwrap();
        let hits = reader
            .search("auth", &["AUTH".into(), "rust".into()], 20)
            .unwrap();
        assert_eq!(
            hits.iter()
                .map(|memory| memory.id.as_str())
                .collect::<Vec<_>>(),
            vec!["workspace", "shared"]
        );
        assert_eq!(reader.get("shared").unwrap().unwrap().id, "shared");
        assert!(reader.get("missing").unwrap().is_none());
    }

    #[test]
    fn the_layer_is_never_persisted_so_v1_115_needs_no_migration() {
        // The Team → Project relabel and the new Team scope changed no
        // file. Prove it from both ends: what we write carries no layer,
        // and what a pre-v1.115.0 Ply wrote loads with the layer its
        // directory implies.
        let mut memory = fixture("id-1", "Auth flow", "body", "2026-05-20T10:00:00Z");
        memory.layer = KnowledgeLayer::Team;
        memory.shared = true;
        let text = encode_memory(&memory).unwrap();
        assert!(!text.contains("layer"), "{text}");
        assert!(!text.contains("shared"), "{text}");

        let legacy = include_str!("../tests/fixtures/legacy-minimal.md");
        let project = tempdir().unwrap();
        let team = tempdir().unwrap();
        for (dir, expected) in [
            (shared_knowledge_dir(project.path()), KnowledgeLayer::Project),
            (team_knowledge_dir(team.path()), KnowledgeLayer::Team),
        ] {
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("legacy.md"), legacy).unwrap();
            let items = read_shared_layer(&dir, expected).unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].layer, expected);
            assert!(items[0].shared);
        }
    }

    #[test]
    fn team_layer_reads_out_of_the_clone_and_is_tagged_team() {
        let clone = tempdir().unwrap();
        let entry = fixture("team-1", "auth team lesson", "body", "2026-02-01T00:00:00Z");
        write_fixture(&team_knowledge_dir(clone.path()).join("auth.md"), &entry);

        let items = read_team(clone.path()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].layer, KnowledgeLayer::Team);
        // Every pre-v1.115.0 caller still sees a shared entry as shared.
        assert!(items[0].shared);
    }

    #[test]
    fn team_layer_is_empty_without_a_clone_and_never_creates_it() {
        let parent = tempdir().unwrap();
        let absent = parent.path().join("no-team-clone");
        assert!(read_team(&absent).unwrap().is_empty());
        assert!(!absent.exists());
    }

    #[test]
    fn project_layer_is_labelled_project_not_team() {
        let project = tempdir().unwrap();
        let entry = fixture("project-1", "auth project lesson", "body", "2026-02-02T00:00:00Z");
        write_fixture(
            &shared_knowledge_dir(project.path()).join("auth.md"),
            &entry,
        );
        let items = read_shared(project.path()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].layer, KnowledgeLayer::Project);
        assert!(items[0].shared);
    }

    #[test]
    fn reader_with_team_searches_and_gets_every_one_of_the_four_layers() {
        let config = tempdir().unwrap();
        let project = tempdir().unwrap();
        let team = tempdir().unwrap();
        let root = memory_root(config.path());

        let mut workspace = fixture("ws", "auth workspace", "body", "2026-01-01T00:00:00Z");
        workspace.scope = MemoryScope::Workspace;
        workspace.workspace_id = Some("ws-1".into());
        write_fixture(
            &root.join(WORKSPACES_DIR).join("ws-1").join("ws.md"),
            &workspace,
        );
        write_fixture(
            &shared_knowledge_dir(project.path()).join("project.md"),
            &fixture("project", "auth project", "body", "2026-01-02T00:00:00Z"),
        );
        write_fixture(
            &team_knowledge_dir(team.path()).join("team.md"),
            &fixture("team", "auth team", "body", "2026-01-03T00:00:00Z"),
        );
        write_fixture(
            &root.join(GLOBAL_DIR).join("global.md"),
            &fixture("global", "auth global", "body", "2026-01-04T00:00:00Z"),
        );

        let reader = AcceptedKnowledgeReader::with_team(
            config.path().to_path_buf(),
            Some("ws-1".into()),
            Some(project.path().to_path_buf()),
            Some(team.path().to_path_buf()),
        )
        .unwrap();
        // Most specific first, then the two shared layers, then personal
        // Global — the Team layer never displaces the project's own answer.
        assert_eq!(
            reader
                .search("auth", &[], 20)
                .unwrap()
                .iter()
                .map(|memory| memory.id.as_str())
                .collect::<Vec<_>>(),
            vec!["ws", "project", "team", "global"]
        );
        let fetched = reader.get("team").unwrap().unwrap();
        assert_eq!(fetched.layer, KnowledgeLayer::Team);
    }

    #[test]
    fn a_broken_team_layer_never_blinds_a_session_to_its_own_knowledge() {
        // The member's own three layers stay strict — silence there would
        // hide corruption of their data. The Team layer is additive and
        // lives in a clone Ply manages, so a damaged one is skipped.
        let config = tempdir().unwrap();
        let team = tempdir().unwrap();
        write_fixture(
            &memory_root(config.path()).join(GLOBAL_DIR).join("g.md"),
            &fixture("global", "auth global", "body", "2026-01-04T00:00:00Z"),
        );
        // A file where `library/knowledge/` belongs.
        fs::create_dir_all(team.path().join(TEAM_KNOWLEDGE_SUBDIR).parent().unwrap()).unwrap();
        fs::write(team_knowledge_dir(team.path()), "not a directory").unwrap();

        let reader = AcceptedKnowledgeReader::with_team(
            config.path().to_path_buf(),
            None,
            None,
            Some(team.path().to_path_buf()),
        )
        .unwrap();
        let hits = reader.search("auth", &[], 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "global");
        assert_eq!(reader.get("global").unwrap().unwrap().id, "global");
        assert!(reader.get("team").unwrap().is_none());

        // The member's own Global layer being broken is still an error.
        let broken = tempdir().unwrap();
        let root = memory_root(broken.path());
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(GLOBAL_DIR), "not a directory").unwrap();
        let strict =
            AcceptedKnowledgeReader::new(broken.path().to_path_buf(), None, None).unwrap();
        assert!(strict.search("", &[], 20).is_err());
    }

    #[test]
    fn reader_without_a_team_clone_still_serves_the_other_layers() {
        let config = tempdir().unwrap();
        write_fixture(
            &memory_root(config.path()).join(GLOBAL_DIR).join("g.md"),
            &fixture("global", "auth global", "body", "2026-01-04T00:00:00Z"),
        );
        let reader = AcceptedKnowledgeReader::with_team(
            config.path().to_path_buf(),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(reader.search("auth", &[], 20).unwrap().len(), 1);
    }

    #[test]
    fn reader_missing_paths_returns_empty_without_creating_anything() {
        let parent = tempdir().unwrap();
        let config = parent.path().join("absent-config");
        let project = parent.path().join("absent-project");
        let reader = AcceptedKnowledgeReader::new(
            config.clone(),
            Some("ws-1".into()),
            Some(project.clone()),
        )
        .unwrap();
        assert!(reader.search("", &[], 20).unwrap().is_empty());
        assert!(reader.get("missing").unwrap().is_none());
        assert!(!config.exists());
        assert!(!project.exists());
    }

    #[test]
    fn reader_skips_one_malformed_file_without_losing_valid_entries() {
        let config = tempdir().unwrap();
        let global_dir = memory_root(config.path()).join(GLOBAL_DIR);
        let valid = fixture("valid", "valid auth note", "body", "2026-01-01T00:00:00Z");
        write_fixture(&global_dir.join("valid.md"), &valid);
        fs::write(global_dir.join("broken.md"), "not frontmatter").unwrap();

        let reader = AcceptedKnowledgeReader::new(config.path().to_path_buf(), None, None).unwrap();
        let hits = reader.search("auth", &[], 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "valid");
    }

    #[test]
    fn strict_reader_errors_when_an_accepted_layer_is_not_a_directory() {
        let config = tempdir().unwrap();
        let root = memory_root(config.path());
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(GLOBAL_DIR), "not a directory").unwrap();

        let reader = AcceptedKnowledgeReader::new(config.path().to_path_buf(), None, None).unwrap();
        assert!(reader.search("", &[], 20).is_err());

        // The compatibility API used by the Tauri cache retains the historic
        // missing/non-directory-is-empty behavior.
        assert!(read_scope(&root, MemoryScope::Global, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn reader_rejects_traversal_workspace_ids() {
        for id in ["", ".", "..", "../secret", "a/b"] {
            assert!(
                AcceptedKnowledgeReader::new(PathBuf::from("/tmp/x"), Some(id.into()), None)
                    .is_err(),
                "accepted unsafe id {id:?}"
            );
        }
    }

    #[test]
    fn slug_rules_preserve_existing_contract() {
        assert_eq!(slugify("Auth flow"), "auth-flow");
        assert_eq!(slugify("Caps & symbols!"), "caps-symbols");
        assert_eq!(slugify("---!!!"), "memory");
        assert!(slugify(&"a".repeat(100)).len() <= SLUG_MAX_LEN);
    }

    #[test]
    fn slug_collision_is_case_insensitive_and_disambiguated() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("AUTH-FLOW.md"), "").unwrap();
        let slug = next_available_slug(dir.path(), "Auth flow").unwrap();
        assert!(slug.starts_with("auth-flow-"));
        assert_ne!(slug, "auth-flow");
    }

    /// GH #206: a directory Ply may write into but not read (mode 0300) is
    /// the case where "could not look" used to mean "no collision".
    #[test]
    #[cfg(unix)]
    fn an_uninspectable_directory_fails_slug_allocation_instead_of_guessing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("auth-flow.md"), "existing").unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o300)).unwrap();
        let result = next_available_slug(dir.path(), "Auth flow");
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let error = result.expect_err("an unreadable directory must not allocate a slug");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        // A missing directory is still simply empty.
        let missing = dir.path().join("not-yet");
        assert_eq!(next_available_slug(&missing, "Auth flow").unwrap(), "auth-flow");
    }
}
