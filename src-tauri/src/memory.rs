//! Tauri-owned cache and mutation layer for accepted Knowledge.
//!
//! Phase 1A moved the canonical types, markdown codec, paths, lexical ranking,
//! and stateless read API into `ply-memory`. This module deliberately retains
//! every mutation and atomic write so the standalone `ply-mcp` sidecar cannot
//! gain a Knowledge write path by depending on the shared crate.

use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[allow(unused_imports)]
pub use ply_memory::MEMORY_SCHEMA_VERSION;
use ply_memory::{
    encode_memory, memory_root, next_available_slug, read_scope, read_shared, read_team, scope_dir,
    search_memories, shared_knowledge_dir, slug_exists_case_insensitive, team_knowledge_dir,
};
#[cfg(test)]
use ply_memory::{slugify, GLOBAL_DIR, SLUG_MAX_LEN, WORKSPACES_DIR};
pub use ply_memory::{KnowledgeLayer, KnowledgeType, Memory, MemoryScope, MemorySource};

/// v1.36.0 (memory Increment 2): top-N memory matches injected into a
/// card dispatch prompt. Five is a balance between "agents see enough
/// prior context" and "we don't blow the prompt budget on cards that
/// touch a thick area of memory." Drop-not-truncate when over budget.
pub const DISPATCH_INJECT_TOP_N: usize = 5;

/// v1.36.0: total char ceiling for the injected memory block (NOT
/// including the heading). At ~2000 chars (~400-500 tokens) this is
/// a small fraction of the typical 200K-token claude context but the
/// real lever it pulls is signal-to-noise in the agent's working set.
/// Drop-not-truncate: a memory that would push over the budget is
/// skipped entirely so we never ship a half-sentence.
pub const DISPATCH_INJECT_CHAR_BUDGET: usize = 2000;

/// GH #208: an `*.atelier-tmp` file in a Knowledge directory older than this
/// is a crash leftover, not a write in flight (an atomic write renames its
/// temp within milliseconds), and the next load removes it.
pub const STALE_TEMP_AFTER: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// FTS ceiling documented in module comment. Past this we should swap to
/// a real index — the linear substring scan starts to feel sluggish around
/// 10k entries per scope in practice.
#[cfg(test)]
const _FTS_CEILING: usize = 10_000;

/// PATCH semantics mirror `CardPatch` (kanban.rs:2021–2050): an absent
/// field means "don't touch"; an explicit `null` (deserialized to
/// `Some(None)`) means "clear"; a value means "set". `Option<Option<T>>`
/// is the standard trick.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPatch {
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub body: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    pub linked_cards: Option<Vec<String>>,
}

fn deserialize_optional_field<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    // Absent field is handled by `#[serde(default)]` on the outer Option,
    // so this is only called when the key IS present. A `null` value
    // deserializes to None; anything else to Some(t).
    Option::<T>::deserialize(deserializer)
}

/// Key by which the cache is partitioned. `Global` is its own bucket;
/// `Workspace(id)` is per-workspace.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ScopeKey {
    Workspace(String),
    Global,
}

impl ScopeKey {
    fn dir_under(&self, root: &Path) -> PathBuf {
        scope_dir(root, self.scope(), self.workspace_id())
            .expect("ScopeKey always carries a valid scope/id pair")
    }

    fn scope(&self) -> MemoryScope {
        match self {
            ScopeKey::Workspace(_) => MemoryScope::Workspace,
            ScopeKey::Global => MemoryScope::Global,
        }
    }

    fn workspace_id(&self) -> Option<&str> {
        match self {
            ScopeKey::Workspace(id) => Some(id.as_str()),
            ScopeKey::Global => None,
        }
    }
}

/// The store. One per process; manages the on-disk tree plus an
/// in-memory cache keyed by scope.
pub struct MemoryStore {
    root: PathBuf,
    /// Lazy cache. A scope key is either present (we've loaded that
    /// scope's directory at least once and the Vec is authoritative) or
    /// absent (we'll load on next access).
    cache: Mutex<HashMap<ScopeKey, Vec<Memory>>>,
    /// GH #82: updates and deletes of an entry run one at a time, so a
    /// check-then-delete (`delete_if_unchanged`) can't interleave with an
    /// edit.
    edits: Mutex<()>,
}

impl MemoryStore {
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        let root = memory_root(&config_dir);
        // Best-effort directory creation. Per-scope subdirs are created
        // lazily on first write to that scope.
        fs::create_dir_all(&root).map_err(|e| format!("create memory root: {e}"))?;
        Ok(Self {
            root,
            cache: Mutex::new(HashMap::new()),
            edits: Mutex::new(()),
        })
    }

    pub fn root_path(&self) -> &Path {
        &self.root
    }

    /// List memories in a scope, ordered by `updated_at` descending.
    pub fn list(
        &self,
        scope: MemoryScope,
        workspace_id: Option<&str>,
    ) -> Result<Vec<Memory>, String> {
        let key = self.key_for(scope, workspace_id)?;
        let mut items = self.load_scope(&key)?;
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(items)
    }

    /// Fetch a single memory by id within a scope. None if absent.
    pub fn get(
        &self,
        scope: MemoryScope,
        workspace_id: Option<&str>,
        id: &str,
    ) -> Result<Option<Memory>, String> {
        let key = self.key_for(scope, workspace_id)?;
        let items = self.load_scope(&key)?;
        Ok(items.into_iter().find(|m| m.id == id))
    }

    /// Find the durable side of an evidence-backed acceptance transition.
    ///
    /// `proposalId + suggestionId` is the retry-idempotency key. This lookup
    /// lets the proposal registry repair a crash after the Markdown rename
    /// but before the proposal JSON disposition was replaced.
    pub fn find_by_evidence(
        &self,
        scope: MemoryScope,
        workspace_id: Option<&str>,
        proposal_id: &str,
        suggestion_id: &str,
    ) -> Result<Option<Memory>, String> {
        let key = self.key_for(scope, workspace_id)?;
        let items = self.load_scope(&key)?;
        Ok(items.into_iter().find(|memory| {
            memory.evidence.as_ref().is_some_and(|evidence| {
                evidence.proposal_id == proposal_id
                    && evidence.suggestion_id.as_deref() == Some(suggestion_id)
            })
        }))
    }

    /// Create a new memory. The caller supplies `title` + `body` + tags
    /// + scope + workspace_id + source; the store assigns id + slug +
    /// timestamps and writes the file. Returns the materialized record.
    pub fn create(&self, input: NewMemory) -> Result<Memory, String> {
        self.create_with(input, allocate_slug)
    }

    /// `create`, with the slug allocation injectable so a test can stand in
    /// for a racing writer whose inspection went stale (GH #206).
    fn create_with(
        &self,
        input: NewMemory,
        allocate: impl FnMut(&Path, &str) -> Result<String, String>,
    ) -> Result<Memory, String> {
        let key = self.key_for(input.scope, input.workspace_id.as_deref())?;
        let now = now_iso();
        let id = uuid::Uuid::new_v4().to_string();
        // Slug must be unique within the scope's directory.
        let scope_dir = key.dir_under(&self.root);
        fs::create_dir_all(&scope_dir).map_err(|e| format!("create scope dir: {e}"))?;
        let mut memory = Memory {
            id,
            // The file name is chosen as it is created, below; the Markdown
            // does not carry it.
            slug: String::new(),
            title: input.title,
            scope: key.scope(),
            workspace_id: key.workspace_id().map(|s| s.to_string()),
            tags: input.tags,
            linked_cards: input.linked_cards,
            source: input.source,
            entry_type: input.entry_type,
            system_prompt: input.system_prompt,
            prompt_template: input.prompt_template,
            shared: false,
            layer: KnowledgeLayer::Personal,
            evidence: input.evidence,
            body: input.body,
            created_at: now.clone(),
            updated_at: now,
        };
        // GH #206: a new note never replaces a file — not one an unreadable
        // directory hid from the slug check, not one a concurrent create
        // published after it.
        let text = encode_memory(&memory)?;
        memory.slug = publish_new_note_with(&scope_dir, &memory.title, &text, allocate)?;
        self.cache
            .lock()
            .entry(key.clone())
            .or_insert_with(Vec::new)
            .push(memory.clone());
        Ok(memory)
    }

    /// Apply a patch. Only fields present in `patch` are changed;
    /// `updated_at` always bumps. Returns the updated record.
    pub fn update(
        &self,
        scope: MemoryScope,
        workspace_id: Option<&str>,
        id: &str,
        patch: MemoryPatch,
    ) -> Result<Memory, String> {
        let _edit = self.edits.lock();
        let key = self.key_for(scope, workspace_id)?;
        let mut items = self.load_scope(&key)?;
        let idx = items
            .iter()
            .position(|m| m.id == id)
            .ok_or_else(|| format!("memory not found: {id}"))?;
        let mut updated = items[idx].clone();
        if let Some(t) = patch.title {
            updated.title = t;
        }
        if let Some(b) = patch.body {
            updated.body = b;
        }
        if let Some(tags) = patch.tags {
            updated.tags = tags;
        }
        if let Some(lc) = patch.linked_cards {
            updated.linked_cards = lc;
        }
        updated.updated_at = now_iso();
        self.write_memory(&key, &updated)?;
        items[idx] = updated.clone();
        self.cache.lock().insert(key, items);
        Ok(updated)
    }

    /// Delete a memory by id. Returns Ok even if the file was already
    /// gone (idempotent at the cache + disk levels).
    pub fn delete(
        &self,
        scope: MemoryScope,
        workspace_id: Option<&str>,
        id: &str,
    ) -> Result<(), String> {
        let _edit = self.edits.lock();
        self.delete_unlocked(scope, workspace_id, id)
    }

    /// GH #82: delete entry `id` only if its `updatedAt` is still
    /// `updated_at` — checked and removed under the edit lock, so an update
    /// landing in between is never deleted. `Ok(false)`: edited or gone.
    pub fn delete_if_unchanged(
        &self,
        scope: MemoryScope,
        workspace_id: Option<&str>,
        id: &str,
        updated_at: &str,
    ) -> Result<bool, String> {
        let _edit = self.edits.lock();
        match self.get(scope, workspace_id, id)? {
            Some(entry) if entry.updated_at == updated_at => {
                self.delete_unlocked(scope, workspace_id, id)?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    fn delete_unlocked(
        &self,
        scope: MemoryScope,
        workspace_id: Option<&str>,
        id: &str,
    ) -> Result<(), String> {
        let key = self.key_for(scope, workspace_id)?;
        let items = self.load_scope(&key)?;
        let target = items
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| format!("memory not found: {id}"))?;
        let path = key
            .dir_under(&self.root)
            .join(format!("{}.md", target.slug));
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("delete file: {e}"))?;
        }
        let new_items: Vec<Memory> = items.into_iter().filter(|m| m.id != id).collect();
        self.cache.lock().insert(key, new_items);
        Ok(())
    }

    /// Case-insensitive term-based FTS over title + body + tags. The
    /// query is split on whitespace into terms (≥2 chars each); a
    /// memory matches if ANY term hits any field. The tier is the
    /// **maximum** across hits: a title-hit term outranks a body-hit
    /// term even if the same memory has more body matches. Results
    /// are sorted by tier desc, then by `updated_at` desc within a
    /// tier. Empty query returns everything (capped by `limit`).
    ///
    /// Term-based (not whole-substring) is critical for the v1.36.0
    /// dispatch-time use case: the query is built from card title +
    /// notes + knowledge — multi-word and rarely a contiguous match
    /// for any memory title. "auth refactor" must still hit a memory
    /// titled "auth flow".
    pub fn search(
        &self,
        scope: MemoryScope,
        workspace_id: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<Memory>, String> {
        let key = self.key_for(scope, workspace_id)?;
        let items = self.load_scope(&key)?;
        Ok(search_memories(&items, query, limit))
    }

    /// v1.36.0: build the "Relevant prior learnings" block prepended at
    /// card dispatch. Combines the workspace's own memories with the
    /// global pool (when `include_global` is true — gated by
    /// `Settings::behavior::inject_global_memories`). Returns an empty
    /// string when no memories match — the caller should then prepend
    /// nothing rather than a header-only block.
    ///
    /// Ranking: workspace-scope matches are preferred at the same FTS
    /// tier (a workspace-specific learning beats a generic global one);
    /// within a scope, FTS ranks title > tag > body, then recency.
    ///
    /// Char budget: a memory whose `- title: body` line would push the
    /// running total over `DISPATCH_INJECT_CHAR_BUDGET` is dropped, not
    /// truncated. Header is not counted toward the budget.
    pub fn compose_dispatch_block(
        &self,
        workspace_id: &str,
        query: &str,
        include_global: bool,
    ) -> String {
        // Search workspace memories first; they outrank global at the
        // same FTS tier.
        let mut candidates: Vec<Memory> = self
            .search(
                MemoryScope::Workspace,
                Some(workspace_id),
                query,
                DISPATCH_INJECT_TOP_N,
            )
            .unwrap_or_default();
        if include_global {
            let need = DISPATCH_INJECT_TOP_N.saturating_sub(candidates.len());
            if need > 0 {
                let global = self
                    .search(MemoryScope::Global, None, query, need)
                    .unwrap_or_default();
                candidates.extend(global);
            }
        }
        if candidates.is_empty() {
            return String::new();
        }
        let mut lines: Vec<String> = Vec::new();
        let mut used = 0usize;
        for m in &candidates {
            let body = m.body.trim();
            let title = m.title.trim();
            let line = if body.is_empty() {
                format!("- {title}")
            } else {
                format!("- {title}: {body}")
            };
            // +1 accounts for the newline that will join this line in.
            let cost = line.len() + 1;
            if used + cost > DISPATCH_INJECT_CHAR_BUDGET {
                continue;
            }
            used += cost;
            lines.push(line);
        }
        if lines.is_empty() {
            return String::new();
        }
        format!("## Relevant prior learnings\n{}", lines.join("\n"))
    }

    /// Edge case #1: when a workspace is deleted, drop its memory dir.
    /// Best-effort — failure logs and returns Ok so the workspace delete
    /// command itself can't be blocked by a memory cleanup hiccup.
    pub fn delete_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let key = ScopeKey::Workspace(workspace_id.to_string());
        let dir = key.dir_under(&self.root);
        if dir.exists() {
            if let Err(e) = fs::remove_dir_all(&dir) {
                log::warn!("memory: cleanup for deleted workspace {workspace_id} failed: {e}");
            }
        }
        self.cache.lock().remove(&key);
        Ok(())
    }

    // ── internals ───────────────────────────────────────

    fn key_for(&self, scope: MemoryScope, workspace_id: Option<&str>) -> Result<ScopeKey, String> {
        match scope {
            MemoryScope::Workspace => {
                let id = workspace_id
                    .ok_or_else(|| "workspace scope requires workspaceId".to_string())?;
                if id.is_empty() {
                    return Err("workspaceId is empty".into());
                }
                Ok(ScopeKey::Workspace(id.to_string()))
            }
            MemoryScope::Global => Ok(ScopeKey::Global),
        }
    }

    /// Load (and cache) the full list of memories in a scope. Files that
    /// fail to parse are logged and skipped — never crash the workspace.
    fn load_scope(&self, key: &ScopeKey) -> Result<Vec<Memory>, String> {
        if let Some(cached) = self.cache.lock().get(key) {
            return Ok(cached.clone());
        }
        // GH #208: the first load of a scope clears what a crash left there.
        sweep_knowledge_temps(&key.dir_under(&self.root), false);
        let items = read_scope(&self.root, key.scope(), key.workspace_id())?;
        self.cache.lock().insert(key.clone(), items.clone());
        Ok(items)
    }

    /// Replace an **existing** note's file in place (an edit keeps its slug).
    /// New notes go through `publish_new_note`, which never replaces.
    fn write_memory(&self, key: &ScopeKey, memory: &Memory) -> Result<(), String> {
        let dir = key.dir_under(&self.root);
        fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
        let path = dir.join(format!("{}.md", memory.slug));
        let text = encode_memory(memory)?;
        crate::atomic::write_atomic_text(&path, &text)
    }
}

/// Input bag for `create`. Separate from `Memory` because the store
/// assigns id, slug, and timestamps.
#[derive(Debug, Clone)]
pub struct NewMemory {
    pub title: String,
    pub body: String,
    pub scope: MemoryScope,
    pub workspace_id: Option<String>,
    pub tags: Vec<String>,
    pub linked_cards: Vec<String>,
    pub source: MemorySource,
    /// v1.68.0 (Knowledge merge): note (default) or prompt + payload.
    pub entry_type: KnowledgeType,
    pub system_prompt: Option<String>,
    pub prompt_template: Option<String>,
    pub evidence: Option<ply_memory::KnowledgeEvidenceEnvelope>,
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ── Team-shared Knowledge layer (v1.72.0 — UX revamp step 5b-2) ────────
//
// The committed counterpart of the Global scope: markdown files (same
// frontmatter format) under `<cwd>/.atelier/library/knowledge/`, reaching
// every teammate via git — the prompts.rs v1.50–1.52 model ported to the
// Knowledge store. promote/demote move the FILE between the personal
// global dir and the repo dir (entries are file-per-record, so the move
// IS the layer change); fork copies a shared entry into a fresh personal
// one.

/// GH #206: allocate `title`'s slug in `dir`, failing when `dir` cannot be
/// inspected.
fn allocate_slug(dir: &Path, title: &str) -> Result<String, String> {
    next_available_slug(dir, title).map_err(|error| {
        format!(
            "Could not check the existing Knowledge in {} for a name clash, so nothing was saved: {error}",
            dir.display()
        )
    })
}

/// How many times a new note looks for a free name before giving up. Each
/// retry follows a concurrent writer taking the name just chosen.
const NEW_NOTE_ATTEMPTS: usize = 8;

/// GH #206: write a **new** note's Markdown into `dir` under a slug no other
/// note has, and return that slug.
///
/// The slug check and the write are two steps, so the write itself refuses to
/// replace anything (`publish_atomic_text`, create-new): a note published in
/// between makes this one choose again rather than overwrite it. Edits of an
/// existing note keep their slug and do not come through here.
pub fn publish_new_note(dir: &Path, title: &str, text: &str) -> Result<String, String> {
    publish_new_note_with(dir, title, text, allocate_slug)
}

fn publish_new_note_with(
    dir: &Path,
    title: &str,
    text: &str,
    mut allocate: impl FnMut(&Path, &str) -> Result<String, String>,
) -> Result<String, String> {
    for _ in 0..NEW_NOTE_ATTEMPTS {
        let slug = allocate(dir, title)?;
        match crate::atomic::publish_atomic_text(&dir.join(format!("{slug}.md")), text) {
            Ok(()) => return Ok(slug),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                log::info!("knowledge: {slug}.md appeared before the new note was written; choosing again");
            }
            Err(error) => return Err(format!("save knowledge: {error}")),
        }
    }
    Err(format!(
        "Could not find a free file name for \"{title}\" in {}; nothing was saved.",
        dir.display()
    ))
}

/// GH #207: what a refused share says, in the error shape (ux-language
/// PATTERNS §4: what happened · what was left untouched · what to do).
///
/// Renaming an entry changes its title, not the name it is stored under, and
/// a different title can still land on the same name (case, punctuation, a
/// non-Latin title). What always works is a new entry with the **same** title:
/// this one still holds the name, so the new one gets a name of its own.
pub fn slug_collision_message() -> String {
    "Couldn't share this entry: the shared Knowledge already has a different entry \
     under the same name. Nothing was changed, here or there. Add a new entry with the \
     same title, text and tags (it gets a name of its own), share that one, then delete \
     this one."
        .to_string()
}

/// GH #208: remove crash-leftover atomic temps from a Knowledge directory.
///
/// Two names are recognised: today's `*.atelier-tmp`, and the `.tmpXXXXXX`
/// (`.tmp` + 6 letters or digits) a shared publish made before the temps were
/// renamed. The second is only looked for here, in Knowledge directories.
///
/// GH #208 review 1: `repo` says the directory may be inside a git work tree
/// someone else owns (the Project checkout, the team clone). There a file git
/// **tracks** is never removed — it is somebody's committed content, whatever
/// its name — so the one `git ls-files` call is made when there is a candidate
/// at all; if git cannot answer, nothing is removed.
fn sweep_knowledge_temps(dir: &Path, repo: bool) {
    let stale = crate::atomic::stale_temp_files(dir, STALE_TEMP_AFTER, |name| {
        crate::atomic::is_atomic_temp(name) || is_legacy_publish_temp(name)
    });
    if stale.is_empty() {
        return;
    }
    let tracked = if repo {
        match tracked_names(dir) {
            Some(tracked) => tracked,
            None => return,
        }
    } else {
        std::collections::HashSet::new()
    };
    let mut removed = 0;
    for path in stale {
        let tracked_here = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| tracked.contains(name));
        if !tracked_here && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!("knowledge: swept {removed} stale temp file(s) from {dir:?}");
    }
}

/// `.tmp` followed by exactly six ASCII letters or digits: tempfile's default
/// name, which `publish_atomic_text` used before GH #208.
fn is_legacy_publish_temp(name: &str) -> bool {
    name.strip_prefix(".tmp")
        .is_some_and(|rest| rest.len() == 6 && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// The names of the files directly in `dir` that git tracks. An empty set when
/// `dir` is not in a git work tree; `None` when git cannot be asked or fails.
fn tracked_names(dir: &Path) -> Option<std::collections::HashSet<String>> {
    let inside = crate::platform::git_command()
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(dir)
        // The "not a git repository" test below reads git's own words.
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !inside.status.success() {
        // Not a work tree (a Ply mirror build, a plain folder): nothing is
        // tracked. Any other refusal (ownership, a broken repo) is "unknown".
        let stderr = String::from_utf8_lossy(&inside.stderr);
        return stderr
            .contains("not a git repository")
            .then(std::collections::HashSet::new);
    }
    if String::from_utf8_lossy(&inside.stdout).trim() != "true" {
        // Inside `.git` itself, or a bare repository: leave it alone.
        return None;
    }
    let listed = crate::platform::git_command()
        .args(["ls-files", "-z", "--", "."])
        .current_dir(dir)
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !listed.status.success() {
        return None;
    }
    Some(
        listed
            .stdout
            .split(|b| *b == 0)
            .filter_map(|path| std::str::from_utf8(path).ok())
            .filter(|path| !path.is_empty() && !path.contains('/'))
            .map(str::to_string)
            .collect(),
    )
}

/// An existing slug is idempotent only when every case variant contains the
/// complete bytes we would publish. Inspect the actual names so Linux handles
/// a teammate's `Auth-Flow.md` just as macOS does.
fn shared_destination_is_identical(dest: &Path, slug: &str, bytes: &[u8]) -> Result<bool, String> {
    let dir = dest
        .parent()
        .ok_or_else(|| "shared destination has no parent".to_string())?;
    let inspection_error = |error| format!("inspect shared knowledge: {error}");
    if !slug_exists_case_insensitive(dir, slug).map_err(inspection_error)? {
        return Ok(false);
    }
    let mut found = false;
    for item in fs::read_dir(dir).map_err(inspection_error)? {
        let item = item.map_err(inspection_error)?;
        let name = item.file_name();
        let matches = name
            .to_str()
            .and_then(|name| name.strip_suffix(".md"))
            .is_some_and(|stem| stem.to_lowercase() == slug.to_lowercase());
        if !matches {
            continue;
        }
        if fs::read(item.path()).map_err(inspection_error)? != bytes {
            return Err(slug_collision_message());
        }
        found = true;
    }
    Ok(found)
}

/// The exact Markdown a shared publish would commit for `entry`.
pub fn encode_memory_entry(entry: &Memory) -> Result<String, String> {
    encode_memory(entry)
}

/// Remove one entry's file from a repo's Project layer, pruning the
/// directory when it becomes empty. Used by the Project → Team promote,
/// whose second half is exactly the removal `demote_to_personal` does.
pub fn remove_project_entry(project_cwd: &Path, slug: &str) -> Result<(), String> {
    let dir = shared_knowledge_dir(project_cwd);
    let path = dir.join(format!("{slug}.md"));
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("remove project knowledge: {error}")),
    }
    if fs::read_dir(&dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
    {
        let _ = fs::remove_dir(&dir);
    }
    Ok(())
}

/// Publish `text` as `<dir>/<slug>.md`, refusing a slug a teammate already
/// used for different content (v1.111.0). Idempotent when the bytes match:
/// re-sharing an entry that is already published changes nothing.
///
/// v1.115.0 takes the destination *directory* rather than a project cwd, so
/// the Project layer (`<repo>/.atelier/library/knowledge/`) and the Team
/// layer (`<app-support>/team/<slug>/library/knowledge/`) share one
/// collision rule instead of growing two that can drift.
pub fn publish_shared_entry(dir: &Path, slug: &str, text: &str) -> Result<(), String> {
    let dest = dir.join(format!("{slug}.md"));
    if shared_destination_is_identical(&dest, slug, text.as_bytes())? {
        return Ok(());
    }
    match crate::atomic::publish_atomic_text(&dest, text) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            // Another writer won publication after our inspection. It must
            // pass the same byte comparison before the caller treats this as
            // a successful publish.
            if shared_destination_is_identical(&dest, slug, text.as_bytes())? {
                Ok(())
            } else {
                Err(format!("publish shared knowledge: {error}"))
            }
        }
        Err(error) => Err(format!("publish shared knowledge: {error}")),
    }
}

impl MemoryStore {
    /// List the repo's committed Project-scope entries. Missing dir ⇒ empty.
    /// Entries surface with layer `Project`, scope Global, no workspace.
    ///
    /// GH #82: a shared workspace's Project layer is its mirror of the
    /// integration branch, not the checkout.
    pub fn list_shared(&self, project_cwd: &Path) -> Result<Vec<Memory>, String> {
        let root = self.project_layer_root(project_cwd);
        sweep_knowledge_temps(&shared_knowledge_dir(&root), true);
        read_shared(&root)
    }

    /// GH #82: where `project_cwd`'s Project layer is read.
    pub fn project_layer_root(&self, project_cwd: &Path) -> PathBuf {
        match self.root.parent() {
            Some(config_dir) => ply_memory::project_layer_root_for_cwd(config_dir, project_cwd),
            None => project_cwd.to_path_buf(),
        }
    }

    /// v1.115.0: list the Team scope out of the team-repo clone
    /// (`<app-support>/team/<slug>/library/knowledge/`). Missing dir ⇒
    /// empty, so a machine with no team key simply has no Team entries.
    pub fn list_team(&self, team_clone_dir: &Path) -> Result<Vec<Memory>, String> {
        sweep_knowledge_temps(&team_knowledge_dir(team_clone_dir), true);
        read_team(team_clone_dir)
    }

    /// v1.115.0: the entry a Share/Promote is about, plus the exact Markdown
    /// that would be published. Separated from the write so the Team layer
    /// can hand the write to `team::publish_library_change`, which must run
    /// it *after* a pull.
    pub fn shared_publish_plan(
        &self,
        scope: MemoryScope,
        workspace_id: Option<&str>,
        id: &str,
    ) -> Result<(Memory, String), String> {
        let entry = self
            .list(scope, workspace_id)?
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| format!("knowledge entry not found in {scope:?}: {id}"))?;
        let text = encode_memory(&entry)?;
        Ok((entry, text))
    }

    /// v1.115.0: copy a shared entry (Project or Team) into the personal
    /// Global layer. `fork` makes an independent copy — new id, no card
    /// links, no longer "suggested"; otherwise it is the second half of a
    /// demote and the entry keeps its provenance.
    pub fn adopt_shared_entry(&self, entry: &Memory, fork: bool) -> Result<Memory, String> {
        self.create(NewMemory {
            title: entry.title.clone(),
            body: entry.body.clone(),
            scope: MemoryScope::Global,
            workspace_id: None,
            tags: entry.tags.clone(),
            linked_cards: if fork {
                Vec::new()
            } else {
                entry.linked_cards.clone()
            },
            source: if fork {
                MemorySource::Manual
            } else {
                entry.source.clone()
            },
            entry_type: entry.entry_type,
            system_prompt: entry.system_prompt.clone(),
            prompt_template: entry.prompt_template.clone(),
            evidence: entry.evidence.clone(),
        })
    }

    /// Move a personal Global entry into the repo's team layer. The file
    /// moves (atomic write to the new home, then delete the old); the id
    /// and slug are preserved so git history reads as one entry.
    pub fn promote_to_shared(&self, id: &str, project_cwd: &Path) -> Result<Memory, String> {
        self.promote_scope_to_shared(MemoryScope::Global, None, id, project_cwd)
    }

    /// Phase 6E: evidence-backed accepted entries originate in Workspace
    /// Knowledge, so the existing team gate must be able to promote that
    /// exact Markdown too. Scope remains explicit; callers cannot search
    /// across workspaces by id.
    pub fn promote_scope_to_shared(
        &self,
        scope: MemoryScope,
        workspace_id: Option<&str>,
        id: &str,
        project_cwd: &Path,
    ) -> Result<Memory, String> {
        let (mut entry, text) = self.shared_publish_plan(scope, workspace_id, id)?;
        publish_shared_entry(&shared_knowledge_dir(project_cwd), &entry.slug, &text)?;
        // Remove from the personal layer (the move's second half).
        self.delete(scope, workspace_id, id)?;
        entry.shared = true;
        entry.layer = KnowledgeLayer::Project;
        Ok(entry)
    }

    /// Inverse of `promote_to_shared`: move a team entry back into the
    /// personal Global layer. Prunes the shared dir if it becomes empty.
    pub fn demote_to_personal(&self, id: &str, project_cwd: &Path) -> Result<Memory, String> {
        let shared = self.list_shared(project_cwd)?;
        let entry = shared
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| format!("knowledge entry not found in shared: {id}"))?;
        let path = shared_knowledge_dir(project_cwd).join(format!("{}.md", entry.slug));
        fs::remove_file(&path).map_err(|error| format!("remove shared knowledge: {error}"))?;
        // Deliberately removal-first: if create fails the shared file is already
        // gone. Transactional rollback is outside this move's current contract.
        let created = self.adopt_shared_entry(&entry, false)?;
        let dir = shared_knowledge_dir(project_cwd);
        if fs::read_dir(&dir)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false)
        {
            let _ = fs::remove_dir(&dir);
        }
        Ok(created)
    }

    /// Copy a team entry into a fresh personal Global entry (new id +
    /// slug). The shared entry is untouched.
    pub fn fork_to_personal(&self, id: &str, project_cwd: &Path) -> Result<Memory, String> {
        let shared = self.list_shared(project_cwd)?;
        let entry = shared
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| format!("knowledge entry not found in shared: {id}"))?;
        self.adopt_shared_entry(&entry, true)
    }

    /// v1.115.0: find one Team-scope entry in the team clone by id.
    pub fn team_entry(&self, team_clone_dir: &Path, id: &str) -> Result<Memory, String> {
        self.list_team(team_clone_dir)?
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| format!("knowledge entry not found in the team library: {id}"))
    }

    /// v1.115.0: the Team layer's directory inside a team-repo clone.
    pub fn team_dir(team_clone_dir: &Path) -> PathBuf {
        team_knowledge_dir(team_clone_dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn manual_input(scope: MemoryScope, workspace_id: Option<&str>, title: &str) -> NewMemory {
        NewMemory {
            title: title.into(),
            body: format!("Body for {title}."),
            scope,
            workspace_id: workspace_id.map(|s| s.to_string()),
            tags: vec!["test".into()],
            linked_cards: vec![],
            source: MemorySource::Manual,
            entry_type: KnowledgeType::Note,
            system_prompt: None,
            prompt_template: None,
            evidence: None,
        }
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Auth flow"), "auth-flow");
        assert_eq!(slugify("  spaces  "), "spaces");
        assert_eq!(slugify("Caps & symbols!"), "caps-symbols");
        assert_eq!(slugify(""), "memory");
        assert_eq!(slugify("---!!!"), "memory");
    }

    #[test]
    fn slugify_truncates_long_titles() {
        let long = "a".repeat(100);
        let s = slugify(&long);
        assert!(s.len() <= SLUG_MAX_LEN);
        assert!(s.chars().all(|c| c == 'a'));
    }

    #[test]
    fn create_then_get_round_trips() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let m = store
            .create(manual_input(MemoryScope::Global, None, "Hello"))
            .unwrap();
        assert!(!m.id.is_empty());
        assert_eq!(m.slug, "hello");
        assert_eq!(m.scope, MemoryScope::Global);
        assert!(m.workspace_id.is_none());
        let fetched = store
            .get(MemoryScope::Global, None, &m.id)
            .unwrap()
            .unwrap();
        assert_eq!(fetched.title, "Hello");
        assert_eq!(fetched.body, "Body for Hello.");
    }

    #[test]
    fn list_orders_by_updated_at_descending() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let a = store
            .create(manual_input(MemoryScope::Global, None, "A"))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let _b = store
            .create(manual_input(MemoryScope::Global, None, "B"))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        // Update A so it becomes the most recent.
        let patch = MemoryPatch {
            body: Some("Updated body".into()),
            ..Default::default()
        };
        store
            .update(MemoryScope::Global, None, &a.id, patch)
            .unwrap();
        let list = store.list(MemoryScope::Global, None).unwrap();
        assert_eq!(list.len(), 2);
        // A was updated last; should be first.
        assert_eq!(list[0].id, a.id);
    }

    #[test]
    fn update_only_touches_specified_fields_and_bumps_updated_at() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let m = store
            .create(manual_input(MemoryScope::Global, None, "Orig"))
            .unwrap();
        let original_created = m.created_at.clone();
        let original_tags = m.tags.clone();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let patch = MemoryPatch {
            title: Some("Renamed".into()),
            ..Default::default()
        };
        let updated = store
            .update(MemoryScope::Global, None, &m.id, patch)
            .unwrap();
        assert_eq!(updated.title, "Renamed");
        // Tags untouched.
        assert_eq!(updated.tags, original_tags);
        // created_at preserved, updated_at advanced.
        assert_eq!(updated.created_at, original_created);
        assert!(updated.updated_at > original_created);
        // Body preserved when not specified.
        assert_eq!(updated.body, "Body for Orig.");
    }

    #[test]
    fn delete_removes_file_and_cache_entry() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let m = store
            .create(manual_input(MemoryScope::Global, None, "Bye"))
            .unwrap();
        let path = store
            .root_path()
            .join(GLOBAL_DIR)
            .join(format!("{}.md", m.slug));
        assert!(path.exists());
        store.delete(MemoryScope::Global, None, &m.id).unwrap();
        assert!(!path.exists());
        assert!(store
            .get(MemoryScope::Global, None, &m.id)
            .unwrap()
            .is_none());
    }

    /// GH #82: settling a promotion deletes only the version that was shared,
    /// and checks and deletes under the lock every update takes.
    #[test]
    fn delete_if_unchanged_spares_an_entry_updated_since() {
        let tmp = tempfile::tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let m = store.create(manual_input(MemoryScope::Global, None, "Shared")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let edited = store
            .update(
                MemoryScope::Global,
                None,
                &m.id,
                MemoryPatch { body: Some("newer".into()), ..Default::default() },
            )
            .unwrap();
        assert!(!store.delete_if_unchanged(MemoryScope::Global, None, &m.id, &m.updated_at).unwrap());
        assert!(store.get(MemoryScope::Global, None, &m.id).unwrap().is_some());
        assert!(store
            .delete_if_unchanged(MemoryScope::Global, None, &m.id, &edited.updated_at)
            .unwrap());
        assert!(store.get(MemoryScope::Global, None, &m.id).unwrap().is_none());

        let source = include_str!("memory.rs");
        for method in ["    pub fn update(", "    pub fn delete(", "    pub fn delete_if_unchanged("] {
            let (_, body) = source.split_once(method).unwrap();
            let (body, _) = body.split_once("\n    }\n").unwrap();
            assert!(body.contains("self.edits.lock()"), "{method} must take the edit lock");
        }
    }

    #[test]
    fn delete_unknown_id_is_error() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(store
            .delete(MemoryScope::Global, None, "no-such-id")
            .is_err());
    }

    #[test]
    fn scopes_are_isolated() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let _wa = store
            .create(manual_input(MemoryScope::Workspace, Some("ws-a"), "in A"))
            .unwrap();
        let _wb = store
            .create(manual_input(MemoryScope::Workspace, Some("ws-b"), "in B"))
            .unwrap();
        let _g = store
            .create(manual_input(MemoryScope::Global, None, "everywhere"))
            .unwrap();
        let a = store.list(MemoryScope::Workspace, Some("ws-a")).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].title, "in A");
        let b = store.list(MemoryScope::Workspace, Some("ws-b")).unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].title, "in B");
        let g = store.list(MemoryScope::Global, None).unwrap();
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].title, "everywhere");
    }

    #[test]
    fn workspace_scope_requires_workspace_id() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        assert!(store.list(MemoryScope::Workspace, None).is_err());
        assert!(store.list(MemoryScope::Workspace, Some("")).is_err());
    }

    #[test]
    fn slug_collision_appends_suffix() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let m1 = store
            .create(manual_input(MemoryScope::Global, None, "Auth flow"))
            .unwrap();
        let m2 = store
            .create(manual_input(MemoryScope::Global, None, "Auth flow"))
            .unwrap();
        assert_eq!(m1.slug, "auth-flow");
        assert_ne!(m2.slug, m1.slug);
        assert!(m2.slug.starts_with("auth-flow-"));
        // Both files exist.
        let p1 = store
            .root_path()
            .join(GLOBAL_DIR)
            .join(format!("{}.md", m1.slug));
        let p2 = store
            .root_path()
            .join(GLOBAL_DIR)
            .join(format!("{}.md", m2.slug));
        assert!(p1.exists());
        assert!(p2.exists());
    }

    #[test]
    fn slug_collision_is_case_insensitive() {
        // Macs default to case-insensitive filesystems — `Auth-Flow.md` and
        // `auth-flow.md` would collide. The collision check must catch it.
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        // Manually plant a fixture file with mixed case.
        let gdir = store.root_path().join(GLOBAL_DIR);
        fs::create_dir_all(&gdir).unwrap();
        fs::write(
            gdir.join("Auth-Flow.md"),
            "---\nschemaVersion: 1\nid: x\ntitle: x\ncreatedAt: 0\nupdatedAt: 0\n---\n",
        )
        .unwrap();
        let m = store
            .create(manual_input(MemoryScope::Global, None, "auth flow"))
            .unwrap();
        // Slug must NOT be "auth-flow" — that would collide on case-insensitive FS.
        assert_ne!(m.slug, "auth-flow");
        assert!(m.slug.starts_with("auth-flow-"));
    }

    #[test]
    fn list_persists_across_store_instances() {
        let tmp = tempdir().unwrap();
        let s1 = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        s1.create(manual_input(MemoryScope::Global, None, "alpha"))
            .unwrap();
        s1.create(manual_input(MemoryScope::Global, None, "beta"))
            .unwrap();
        let s2 = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let loaded = s2.list(MemoryScope::Global, None).unwrap();
        assert_eq!(loaded.len(), 2);
        let titles: Vec<&str> = loaded.iter().map(|m| m.title.as_str()).collect();
        assert!(titles.contains(&"alpha"));
        assert!(titles.contains(&"beta"));
    }

    #[test]
    fn search_ranks_title_above_tag_above_body() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let mk = |title: &str, body: &str, tags: Vec<&str>| NewMemory {
            title: title.into(),
            body: body.into(),
            scope: MemoryScope::Global,
            workspace_id: None,
            tags: tags.into_iter().map(|s| s.into()).collect(),
            linked_cards: vec![],
            source: MemorySource::Manual,
            entry_type: KnowledgeType::Note,
            system_prompt: None,
            prompt_template: None,
            evidence: None,
        };
        store
            .create(mk("alpha title", "no match here", vec![]))
            .unwrap();
        store
            .create(mk("unrelated", "alpha buried in body", vec![]))
            .unwrap();
        store
            .create(mk("unrelated2", "no match", vec!["alpha-tag"]))
            .unwrap();
        let hits = store
            .search(MemoryScope::Global, None, "alpha", 10)
            .unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].title, "alpha title");
        // The tag-tier match must come before the body-tier match.
        assert!(hits[1].tags.iter().any(|t| t == "alpha-tag"));
        assert_eq!(hits[2].title, "unrelated");
    }

    #[test]
    fn empty_query_returns_everything_capped_by_limit() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        for i in 0..5 {
            store
                .create(manual_input(MemoryScope::Global, None, &format!("m{i}")))
                .unwrap();
        }
        let three = store.search(MemoryScope::Global, None, "", 3).unwrap();
        assert_eq!(three.len(), 3);
    }

    #[test]
    fn delete_workspace_removes_dir_and_cache() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create(manual_input(MemoryScope::Workspace, Some("ws-x"), "doomed"))
            .unwrap();
        let dir = store.root_path().join(WORKSPACES_DIR).join("ws-x");
        assert!(dir.exists());
        store.delete_workspace("ws-x").unwrap();
        assert!(!dir.exists());
        // Subsequent list returns empty (and re-creates an empty cache entry).
        let l = store.list(MemoryScope::Workspace, Some("ws-x")).unwrap();
        assert!(l.is_empty());
    }

    // ── compose_dispatch_block (v1.36.0 / Increment 2) ─

    fn ws_mk(workspace_id: &str, title: &str, body: &str) -> NewMemory {
        NewMemory {
            title: title.into(),
            body: body.into(),
            scope: MemoryScope::Workspace,
            workspace_id: Some(workspace_id.into()),
            tags: vec![],
            linked_cards: vec![],
            source: MemorySource::Manual,
            entry_type: KnowledgeType::Note,
            system_prompt: None,
            prompt_template: None,
            evidence: None,
        }
    }

    fn global_mk(title: &str, body: &str) -> NewMemory {
        NewMemory {
            title: title.into(),
            body: body.into(),
            scope: MemoryScope::Global,
            workspace_id: None,
            tags: vec![],
            linked_cards: vec![],
            source: MemorySource::Manual,
            entry_type: KnowledgeType::Note,
            system_prompt: None,
            prompt_template: None,
            evidence: None,
        }
    }

    // ── shared Knowledge layer (v1.72.0 / step 5b-2) ─

    fn directory_bytes(dir: &Path) -> Vec<(String, Vec<u8>)> {
        if !dir.exists() {
            return vec![];
        }
        let mut files: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|item| {
                let item = item.unwrap();
                (
                    item.file_name().to_string_lossy().into_owned(),
                    fs::read(item.path()).unwrap(),
                )
            })
            .collect();
        files.sort();
        files
    }

    #[test]
    fn shared_knowledge_collision_preserves_both_layers_in_both_scopes() {
        for scope in [MemoryScope::Global, MemoryScope::Workspace] {
            for filename in ["auth-flow.md", "Auth-Flow.md"] {
                // Same title/body is insufficient: metadata and raw encoding
                // differences must be refused too, including an edited same ID.
                for difference in ["body", "id", "timestamp", "line endings"] {
                    let cfg = tempdir().unwrap();
                    let repo = tempdir().unwrap();
                    let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
                    let ws = (scope == MemoryScope::Workspace).then_some("ws-collision");
                    let mut input = global_mk("Auth flow", "our instructions");
                    input.scope = scope;
                    input.workspace_id = ws.map(str::to_string);
                    let ours = store.create(input).unwrap();
                    let mut theirs = ours.clone();
                    match difference {
                        "body" => theirs.body = "teammate instructions".into(),
                        "id" => theirs.id = "teammate-id".into(),
                        "timestamp" => theirs.updated_at = "2000-01-01T00:00:00Z".into(),
                        _ => {}
                    }
                    let mut text = encode_memory(&theirs).unwrap();
                    if difference == "line endings" {
                        text = text.replace('\n', "\r\n");
                    }
                    let shared_dir = shared_knowledge_dir(repo.path());
                    fs::create_dir_all(&shared_dir).unwrap();
                    fs::write(shared_dir.join(filename), text).unwrap();
                    let personal_dir = scope_dir(store.root_path(), scope, ws).unwrap();
                    let personal_before = directory_bytes(&personal_dir);
                    let shared_before = directory_bytes(&shared_dir);
                    let cached_before =
                        serde_json::to_value(store.list(scope, ws).unwrap()).unwrap();
                    let listed_before =
                        serde_json::to_value(store.list_shared(repo.path()).unwrap()).unwrap();

                    let result = match scope {
                        MemoryScope::Global => store.promote_to_shared(&ours.id, repo.path()),
                        MemoryScope::Workspace => {
                            store.promote_scope_to_shared(scope, ws, &ours.id, repo.path())
                        }
                    };
                    assert_eq!(result.unwrap_err(), slug_collision_message());
                    assert_eq!(directory_bytes(&personal_dir), personal_before);
                    assert_eq!(directory_bytes(&shared_dir), shared_before);
                    assert_eq!(
                        serde_json::to_value(store.list(scope, ws).unwrap()).unwrap(),
                        cached_before
                    );
                    assert_eq!(
                        serde_json::to_value(store.list_shared(repo.path()).unwrap()).unwrap(),
                        listed_before
                    );
                }
            }
        }
    }

    #[test]
    fn shared_knowledge_identical_destination_finishes_move_in_both_scopes() {
        for scope in [MemoryScope::Global, MemoryScope::Workspace] {
            for filename in ["auth-flow.md", "Auth-Flow.md"] {
                let cfg = tempdir().unwrap();
                let repo = tempdir().unwrap();
                let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
                let ws = (scope == MemoryScope::Workspace).then_some("ws-identical");
                let mut input = global_mk("Auth flow", "instructions");
                input.scope = scope;
                input.workspace_id = ws.map(str::to_string);
                let entry = store.create(input).unwrap();
                let shared_dir = shared_knowledge_dir(repo.path());
                fs::create_dir_all(&shared_dir).unwrap();
                fs::write(shared_dir.join(filename), encode_memory(&entry).unwrap()).unwrap();
                let before = directory_bytes(&shared_dir);
                let promoted = store
                    .promote_scope_to_shared(scope, ws, &entry.id, repo.path())
                    .unwrap();
                assert!(promoted.shared);
                assert_eq!(promoted.id, entry.id);
                assert_eq!(directory_bytes(&shared_dir), before);
                assert!(
                    directory_bytes(&scope_dir(store.root_path(), scope, ws).unwrap()).is_empty()
                );
                assert!(store.list(scope, ws).unwrap().is_empty());
                assert_eq!(store.list_shared(repo.path()).unwrap().len(), 1);
            }
        }
    }

    #[cfg(unix)]
    struct RestoreDirectoryPermissions(PathBuf, fs::Permissions);

    #[cfg(unix)]
    impl Drop for RestoreDirectoryPermissions {
        fn drop(&mut self) {
            fs::set_permissions(&self.0, self.1.clone()).expect("restore fixture permissions");
        }
    }

    #[cfg(unix)]
    #[test]
    fn shared_knowledge_demote_removal_failure_preserves_shared_and_creates_nothing() {
        use std::os::unix::fs::PermissionsExt;
        // Root bypasses directory mode bits: fail explicitly instead of silently
        // passing a fixture that never exercised the removal error.
        assert_ne!(
            unsafe { libc::geteuid() },
            0,
            "run this permission regression as an unprivileged user"
        );
        let cfg = tempdir().unwrap();
        let repo = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let entry = store
            .create(global_mk("Auth flow", "instructions"))
            .unwrap();
        store.promote_to_shared(&entry.id, repo.path()).unwrap();
        let shared_dir = shared_knowledge_dir(repo.path());
        let personal_dir = scope_dir(store.root_path(), MemoryScope::Global, None).unwrap();
        let bytes_before = directory_bytes(&shared_dir);
        let listed_before = serde_json::to_value(store.list_shared(repo.path()).unwrap()).unwrap();
        let cached_before =
            serde_json::to_value(store.list(MemoryScope::Global, None).unwrap()).unwrap();
        let _restore = RestoreDirectoryPermissions(
            shared_dir.clone(),
            fs::metadata(&shared_dir).unwrap().permissions(),
        );
        fs::set_permissions(&shared_dir, fs::Permissions::from_mode(0o555)).unwrap();
        let os_error = fs::remove_file(shared_dir.join("auth-flow.md"))
            .expect_err("fixture must deny removal while allowing reads");
        let error = store
            .demote_to_personal(&entry.id, repo.path())
            .unwrap_err();
        assert_eq!(error, format!("remove shared knowledge: {os_error}"));
        assert_eq!(directory_bytes(&shared_dir), bytes_before);
        assert_eq!(
            serde_json::to_value(store.list_shared(repo.path()).unwrap()).unwrap(),
            listed_before
        );
        assert_eq!(
            serde_json::to_value(store.list(MemoryScope::Global, None).unwrap()).unwrap(),
            cached_before
        );
        assert!(directory_bytes(&personal_dir).is_empty());
    }

    #[test]
    fn shared_knowledge_inspection_error_preserves_personal_source() {
        let cfg = tempdir().unwrap();
        let repo = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let entry = store
            .create(global_mk("Auth flow", "instructions"))
            .unwrap();
        let shared_dir = shared_knowledge_dir(repo.path());
        fs::create_dir_all(&shared_dir).unwrap();
        // An existing unreadable-as-text destination must not be mistaken for
        // absence (portable even for privileged runners).
        fs::create_dir(shared_dir.join("auth-flow.md")).unwrap();
        let personal_dir = scope_dir(store.root_path(), MemoryScope::Global, None).unwrap();
        let before = directory_bytes(&personal_dir);
        assert!(store
            .promote_to_shared(&entry.id, repo.path())
            .unwrap_err()
            .starts_with("inspect shared knowledge:"));
        assert_eq!(directory_bytes(&personal_dir), before);
        assert_eq!(store.list(MemoryScope::Global, None).unwrap().len(), 1);
        assert!(shared_dir.join("auth-flow.md").is_dir());
    }

    #[test]
    fn shared_knowledge_promote_demote_fork_round_trip() {
        let cfg = tempdir().unwrap();
        let repo = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let evidence = ply_memory::KnowledgeEvidenceEnvelope {
            schema_version: ply_memory::EVIDENCE_SCHEMA_VERSION,
            proposal_id: "kp-preserve".into(),
            suggestion_id: Some("kps-preserve".into()),
            ship: ply_memory::ShipEvidence {
                commit_sha: "commit-preserve".into(),
                ..ply_memory::ShipEvidence::default()
            },
            landed_diff: ply_memory::DiffEvidence {
                excerpt: Some("line one\n---\r\nline two".into()),
                sha256: "diff-preserve".into(),
                ..ply_memory::DiffEvidence::default()
            },
            ..ply_memory::KnowledgeEvidenceEnvelope::default()
        };
        let mut input = global_mk("team rule", "always X");
        input.evidence = Some(evidence.clone());
        let evidence_bytes = serde_json::to_vec(&evidence).unwrap();
        let m = store.create(input).unwrap();
        let edited = store
            .update(
                MemoryScope::Global,
                None,
                &m.id,
                MemoryPatch {
                    title: Some("edited team rule".into()),
                    ..MemoryPatch::default()
                },
            )
            .unwrap();
        assert_eq!(edited.evidence.as_ref(), Some(&evidence));
        assert_eq!(
            serde_json::to_vec(edited.evidence.as_ref().unwrap()).unwrap(),
            evidence_bytes
        );

        // Promote: file moves into the repo's committed layer.
        let promoted = store.promote_to_shared(&m.id, repo.path()).unwrap();
        assert!(promoted.shared);
        assert_eq!(promoted.evidence.as_ref(), Some(&evidence));
        assert_eq!(
            serde_json::to_vec(promoted.evidence.as_ref().unwrap()).unwrap(),
            evidence_bytes
        );
        assert!(repo
            .path()
            .join(".atelier/library/knowledge")
            .join(format!("{}.md", m.slug))
            .exists());
        assert!(store.list(MemoryScope::Global, None).unwrap().is_empty());
        let listed = store.list_shared(repo.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].shared);
        assert_eq!(listed[0].id, m.id);
        assert_eq!(listed[0].evidence.as_ref(), Some(&evidence));

        // Fork: fresh personal copy, shared untouched.
        let forked = store.fork_to_personal(&m.id, repo.path()).unwrap();
        assert_ne!(forked.id, m.id);
        assert!(!forked.shared);
        assert_eq!(forked.evidence.as_ref(), Some(&evidence));
        assert_eq!(
            serde_json::to_vec(forked.evidence.as_ref().unwrap()).unwrap(),
            evidence_bytes
        );
        assert_eq!(store.list_shared(repo.path()).unwrap().len(), 1);

        // Demote: back to personal; empty shared dir pruned.
        let demoted = store.demote_to_personal(&m.id, repo.path()).unwrap();
        assert!(!demoted.shared);
        assert_eq!(demoted.evidence.as_ref(), Some(&evidence));
        assert_eq!(
            serde_json::to_vec(demoted.evidence.as_ref().unwrap()).unwrap(),
            evidence_bytes
        );
        assert!(store.list_shared(repo.path()).unwrap().is_empty());
        assert!(!repo.path().join(".atelier/library/knowledge").exists());
        assert_eq!(store.list(MemoryScope::Global, None).unwrap().len(), 2);
    }

    #[test]
    fn evidence_backed_workspace_memory_can_use_the_existing_team_gate() {
        let cfg = tempdir().unwrap();
        let repo = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let evidence = ply_memory::KnowledgeEvidenceEnvelope {
            schema_version: ply_memory::EVIDENCE_SCHEMA_VERSION,
            proposal_id: "kp-workspace-promote".into(),
            suggestion_id: Some("kps-workspace-promote".into()),
            ship: ply_memory::ShipEvidence {
                commit_sha: "commit-workspace-promote".into(),
                ..Default::default()
            },
            landed_diff: ply_memory::DiffEvidence {
                excerpt: Some("exact bounded diff text".into()),
                ..Default::default()
            },
            ..Default::default()
        };
        let mut input = ws_mk("ws-promote", "accepted rule", "keep evidence");
        input.evidence = Some(evidence.clone());
        let memory = store.create(input).unwrap();

        let promoted = store
            .promote_scope_to_shared(
                MemoryScope::Workspace,
                Some("ws-promote"),
                &memory.id,
                repo.path(),
            )
            .unwrap();
        assert!(promoted.shared);
        assert_eq!(promoted.evidence.as_ref(), Some(&evidence));
        assert!(store
            .list(MemoryScope::Workspace, Some("ws-promote"))
            .unwrap()
            .is_empty());
        let shared = store.list_shared(repo.path()).unwrap();
        assert_eq!(shared.len(), 1);
        assert_eq!(shared[0].evidence.as_ref(), Some(&evidence));
    }

    #[test]
    fn compose_dispatch_block_empty_when_no_matches() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        store.create(ws_mk("ws", "tofu", "soy")).unwrap();
        // Query has no overlap with any memory.
        let block = store.compose_dispatch_block("ws", "completely unrelated", false);
        assert!(block.is_empty(), "expected empty block, got: {block:?}");
    }

    #[test]
    fn compose_dispatch_block_prepends_top_matches_with_header() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create(ws_mk("ws", "auth flow", "uses JWT in cookies"))
            .unwrap();
        store.create(ws_mk("ws", "unrelated", "no match")).unwrap();
        let block = store.compose_dispatch_block("ws", "auth", false);
        assert!(block.starts_with("## Relevant prior learnings\n"));
        assert!(block.contains("auth flow: uses JWT in cookies"));
        assert!(!block.contains("unrelated"));
    }

    #[test]
    fn compose_dispatch_block_excludes_global_when_disabled() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create(global_mk("auth thing", "from global"))
            .unwrap();
        let block = store.compose_dispatch_block("ws", "auth", false);
        // include_global = false → no global memory in the block.
        assert!(
            block.is_empty(),
            "expected empty when global excluded; got {block:?}"
        );
    }

    #[test]
    fn compose_dispatch_block_includes_global_when_enabled() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        store
            .create(global_mk("auth thing", "from global"))
            .unwrap();
        let block = store.compose_dispatch_block("ws", "auth", true);
        assert!(block.contains("auth thing: from global"));
    }

    #[test]
    fn compose_dispatch_block_prefers_workspace_over_global() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        // Both match the query equally on title.
        store
            .create(global_mk("auth global", "global body"))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        store
            .create(ws_mk("ws", "auth workspace", "workspace body"))
            .unwrap();
        let block = store.compose_dispatch_block("ws", "auth", true);
        let ws_pos = block.find("auth workspace").expect("workspace line");
        let g_pos = block.find("auth global").expect("global line");
        assert!(
            ws_pos < g_pos,
            "workspace must precede global; block was: {block}"
        );
    }

    #[test]
    fn compose_dispatch_block_caps_at_top_n() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        // Create more than TOP_N matches.
        for i in 0..(DISPATCH_INJECT_TOP_N + 3) {
            store
                .create(ws_mk("ws", &format!("matches q-{i}"), "short"))
                .unwrap();
        }
        let block = store.compose_dispatch_block("ws", "matches", false);
        // Count " matches q-" occurrences.
        let count = block.matches(" matches q-").count();
        assert_eq!(count, DISPATCH_INJECT_TOP_N);
    }

    #[test]
    fn compose_dispatch_block_drops_over_budget_does_not_truncate() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        // One small + one giant. The giant must be dropped wholesale,
        // not truncated.
        store.create(ws_mk("ws", "fits q", "short body")).unwrap();
        let huge_body = "x".repeat(DISPATCH_INJECT_CHAR_BUDGET + 500);
        store.create(ws_mk("ws", "too big q", &huge_body)).unwrap();
        let block = store.compose_dispatch_block("ws", "q", false);
        assert!(block.contains("fits q: short body"));
        // The huge one's body must not appear at all (drop-not-truncate).
        assert!(
            !block.contains(&"x".repeat(100)),
            "huge memory was truncated and inserted; block has it"
        );
        // Hard upper bound on the block: header (~30) + body (<= budget).
        assert!(block.len() < DISPATCH_INJECT_CHAR_BUDGET + 200);
    }

    #[test]
    fn compose_dispatch_block_handles_memory_with_empty_body() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        store.create(ws_mk("ws", "title only q", "")).unwrap();
        let block = store.compose_dispatch_block("ws", "q", false);
        // Title-only memories should render as just "- title" (no trailing colon).
        assert!(block.contains("- title only q\n") || block.ends_with("- title only q"));
        assert!(!block.contains("title only q: "));
    }

    #[test]
    fn corrupt_file_in_dir_is_skipped_not_fatal() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        // Plant one good and one corrupt file.
        store
            .create(manual_input(MemoryScope::Global, None, "good"))
            .unwrap();
        let gdir = store.root_path().join(GLOBAL_DIR);
        fs::write(gdir.join("corrupt.md"), "not a frontmatter file").unwrap();
        // Force a fresh load.
        store.cache.lock().clear();
        let list = store.list(MemoryScope::Global, None).unwrap();
        // Only the good one survives; the corrupt one is logged-and-skipped.
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "good");
    }
    // ── Team scope (v1.115.0 — team sharing rung 2) ───────────────────

    #[test]
    fn team_scope_reads_out_of_the_clone_and_is_labelled_team_not_project() {
        let cfg = tempdir().unwrap();
        let clone = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let entry = store.create(global_mk("Auth flow", "instructions")).unwrap();
        let dir = MemoryStore::team_dir(clone.path());
        fs::create_dir_all(&dir).unwrap();
        publish_shared_entry(&dir, &entry.slug, &encode_memory(&entry).unwrap()).unwrap();

        let listed = store.list_team(clone.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].layer, KnowledgeLayer::Team);
        assert!(listed[0].shared);
        assert_eq!(store.team_entry(clone.path(), &entry.id).unwrap().id, entry.id);
        assert!(store.team_entry(clone.path(), "absent").is_err());
    }

    #[test]
    fn team_scope_slug_collision_is_refused_exactly_as_the_project_scope_is() {
        for filename in ["auth-flow.md", "Auth-Flow.md"] {
            let cfg = tempdir().unwrap();
            let clone = tempdir().unwrap();
            let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
            let ours = store.create(global_mk("Auth flow", "our instructions")).unwrap();
            let mut theirs = ours.clone();
            theirs.body = "teammate instructions".into();

            let dir = MemoryStore::team_dir(clone.path());
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(filename), encode_memory(&theirs).unwrap()).unwrap();
            let before = directory_bytes(&dir);

            let (entry, text) = store
                .shared_publish_plan(MemoryScope::Global, None, &ours.id)
                .unwrap();
            let error = publish_shared_entry(&dir, &entry.slug, &text).unwrap_err();
            assert_eq!(
                error,
                slug_collision_message()
            );
            // Refused means nothing moved: the team library is untouched and
            // the entry is still the member's own.
            assert_eq!(directory_bytes(&dir), before);
            assert_eq!(store.list(MemoryScope::Global, None).unwrap().len(), 1);
        }
    }

    #[test]
    fn republishing_identical_bytes_into_the_team_scope_is_idempotent() {
        let cfg = tempdir().unwrap();
        let clone = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let entry = store.create(global_mk("Auth flow", "instructions")).unwrap();
        let dir = MemoryStore::team_dir(clone.path());
        fs::create_dir_all(&dir).unwrap();
        let text = encode_memory(&entry).unwrap();
        publish_shared_entry(&dir, &entry.slug, &text).unwrap();
        let before = directory_bytes(&dir);
        publish_shared_entry(&dir, &entry.slug, &text).unwrap();
        assert_eq!(directory_bytes(&dir), before);
    }

    #[test]
    fn adopting_a_shared_entry_forks_or_demotes_it() {
        let cfg = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let mut shared = store.create(global_mk("Auth flow", "instructions")).unwrap();
        shared.linked_cards = vec!["card-1".into()];
        shared.source = MemorySource::Suggested {
            run_id: Some("run-1".into()),
            card_id: Some("card-1".into()),
        };
        shared.shared = true;
        shared.layer = KnowledgeLayer::Team;

        // A demote keeps the entry's provenance; it is the same lesson,
        // moved back to the person who wrote it.
        let demoted = store.adopt_shared_entry(&shared, false).unwrap();
        assert_eq!(demoted.linked_cards, vec!["card-1".to_string()]);
        assert_eq!(demoted.source, shared.source);
        assert_eq!(demoted.scope, MemoryScope::Global);
        assert!(!demoted.shared);
        assert_eq!(demoted.layer, KnowledgeLayer::Personal);

        // A fork is an independent copy: new id, no card links, manual.
        let forked = store.adopt_shared_entry(&shared, true).unwrap();
        assert_ne!(forked.id, shared.id);
        assert!(forked.linked_cards.is_empty());
        assert_eq!(forked.source, MemorySource::Manual);
        assert_eq!(forked.body, shared.body);
    }

    #[test]
    fn removing_a_project_entry_prunes_the_directory_and_is_idempotent() {
        let cfg = tempdir().unwrap();
        let repo = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let entry = store.create(global_mk("Auth flow", "instructions")).unwrap();
        let promoted = store.promote_to_shared(&entry.id, repo.path()).unwrap();
        assert_eq!(promoted.layer, KnowledgeLayer::Project);
        assert_eq!(store.list_shared(repo.path()).unwrap().len(), 1);

        remove_project_entry(repo.path(), &promoted.slug).unwrap();
        assert!(store.list_shared(repo.path()).unwrap().is_empty());
        assert!(!shared_knowledge_dir(repo.path()).exists());
        // The Project → Team promote can run twice on a slow double-click.
        remove_project_entry(repo.path(), &promoted.slug).unwrap();
    }
    /// The Challenger's P1: the push is a network round trip, so the source
    /// can change while it runs. Removing it by id afterwards would delete
    /// the newer text while the team library held only the older. The
    /// re-read before the delete is what prevents that; this proves the
    /// comparison it relies on actually distinguishes the two.
    #[test]
    fn an_edit_during_the_push_no_longer_matches_the_published_bytes() {
        let cfg = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let entry = store.create(global_mk("Auth flow", "first")).unwrap();

        let (_, published) = store
            .shared_publish_plan(MemoryScope::Global, None, &entry.id)
            .unwrap();
        // Re-reading an untouched entry is byte-identical, so the ordinary
        // share still removes its source.
        let (_, unchanged) = store
            .shared_publish_plan(MemoryScope::Global, None, &entry.id)
            .unwrap();
        assert_eq!(unchanged, published);

        // A save landing mid-push changes the bytes, so the source is kept.
        store
            .update(
                MemoryScope::Global,
                None,
                &entry.id,
                MemoryPatch {
                    body: Some("second, edited while pushing".into()),
                    ..MemoryPatch::default()
                },
            )
            .unwrap();
        let (_, edited) = store
            .shared_publish_plan(MemoryScope::Global, None, &entry.id)
            .unwrap();
        assert_ne!(edited, published);
        assert!(edited.contains("second, edited while pushing"));

        // And a source that vanished mid-push is "nothing left to remove",
        // not an error that would strand the published entry.
        store.delete(MemoryScope::Global, None, &entry.id).unwrap();
        assert!(store
            .shared_publish_plan(MemoryScope::Global, None, &entry.id)
            .is_err());
    }

    // ── GH #206: a new note never takes an existing note's file ──────

    /// Every `.md` in `dir` with its bytes.
    #[cfg(unix)]
    fn notes_in(dir: &Path) -> Vec<(String, Vec<u8>)> {
        directory_bytes(dir)
            .into_iter()
            .filter(|(name, _)| name.ends_with(".md"))
            .collect()
    }

    /// A scope directory Ply can write into but not list (mode 0300): the
    /// slug check cannot see `hello.md`, and before GH #206 the create went
    /// ahead as if it were absent and replaced it.
    #[test]
    #[cfg(unix)]
    fn a_create_in_an_uninspectable_directory_fails_and_changes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        store.create(global_mk("Hello", "the original note")).unwrap();
        let dir = store.root_path().join(GLOBAL_DIR);
        let before = notes_in(&dir);
        assert_eq!(before.len(), 1);

        fs::set_permissions(&dir, fs::Permissions::from_mode(0o300)).unwrap();
        let result = store.create(global_mk("Hello", "a different note"));
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();

        let error = result.expect_err("an uninspectable directory must refuse the create");
        assert!(error.contains("name clash") && error.contains("nothing was saved"), "{error}");
        assert_eq!(directory_bytes(&dir), before, "existing bytes unchanged, no temp left");
        // The refused note is not in the cache either.
        assert_eq!(store.list(MemoryScope::Global, None).unwrap().len(), 1);
    }

    /// The slug check and the write are two steps: a note another writer
    /// publishes in between must make this one choose again, not be replaced.
    #[test]
    fn a_new_note_never_replaces_one_published_after_its_slug_check() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let theirs = store.create(global_mk("Hello", "their note")).unwrap();
        assert_eq!(theirs.slug, "hello");
        let dir = store.root_path().join(GLOBAL_DIR);
        let theirs_bytes = fs::read(dir.join("hello.md")).unwrap();

        // The first allocation is the stale one a racing writer saw.
        let mut calls = 0;
        let ours = store
            .create_with(global_mk("Hello", "our note"), |dir, title| {
                calls += 1;
                if calls == 1 {
                    Ok("hello".to_string())
                } else {
                    allocate_slug(dir, title)
                }
            })
            .unwrap();
        assert_eq!(calls, 2, "the taken name is given up, then a free one chosen");
        assert_ne!(ours.slug, "hello");
        assert_eq!(fs::read(dir.join("hello.md")).unwrap(), theirs_bytes);

        store.cache.lock().clear();
        let mut bodies: Vec<String> = store
            .list(MemoryScope::Global, None)
            .unwrap()
            .into_iter()
            .map(|m| m.body)
            .collect();
        bodies.sort();
        assert_eq!(bodies, ["our note", "their note"]);
    }

    /// Many creates of one title at once: every note keeps its own file.
    #[test]
    fn concurrent_creates_of_one_title_all_survive() {
        let tmp = tempdir().unwrap();
        let store = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        let barrier = std::sync::Barrier::new(8);
        let created: Vec<Memory> = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..8)
                .map(|n| {
                    let (store, barrier) = (&store, &barrier);
                    scope.spawn(move || {
                        barrier.wait();
                        store.create(global_mk("Hello", &format!("note {n}"))).unwrap()
                    })
                })
                .collect();
            workers.into_iter().map(|w| w.join().unwrap()).collect()
        });
        let mut slugs: Vec<&str> = created.iter().map(|m| m.slug.as_str()).collect();
        slugs.sort();
        slugs.dedup();
        assert_eq!(slugs.len(), 8, "{slugs:?}");
        let fresh = MemoryStore::new(tmp.path().to_path_buf()).unwrap();
        assert_eq!(fresh.list(MemoryScope::Global, None).unwrap().len(), 8);
    }

    /// The Project checkout's new-note path (`knowledge_project_save`) goes
    /// through `publish_new_note`: same refusal, same no-overwrite.
    #[test]
    #[cfg(unix)]
    fn a_new_project_note_never_replaces_an_existing_one() {
        use std::os::unix::fs::PermissionsExt;
        let repo = tempdir().unwrap();
        let dir = shared_knowledge_dir(repo.path());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("hello.md"), "a teammate's note").unwrap();

        fs::set_permissions(&dir, fs::Permissions::from_mode(0o300)).unwrap();
        let refused = publish_new_note(&dir, "Hello", "mine");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(refused.is_err());
        assert_eq!(directory_bytes(&dir), vec![("hello.md".to_string(), b"a teammate's note".to_vec())]);

        let slug = publish_new_note(&dir, "Hello", "mine").unwrap();
        assert_ne!(slug, "hello");
        assert_eq!(fs::read(dir.join("hello.md")).unwrap(), b"a teammate's note");
        assert_eq!(fs::read(dir.join(format!("{slug}.md"))).unwrap(), b"mine");
    }

    // ── GH #207: the collision advice names a way out that works ─────

    /// The advice works for any title — plain, one that differs only in case
    /// and punctuation, and a non-Latin one (whose stored name is `memory`).
    #[test]
    fn the_slug_collision_advice_is_an_action_that_resolves_it() {
        for (title, taken) in [
            ("Auth flow", "auth-flow"),
            ("AUTH—Flow!", "auth-flow"),
            ("認証フロー", "memory"),
        ] {
            let cfg = tempdir().unwrap();
            let repo = tempdir().unwrap();
            let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
            let shared_dir = shared_knowledge_dir(repo.path());
            fs::create_dir_all(&shared_dir).unwrap();
            let theirs = shared_dir.join(format!("{taken}.md"));
            fs::write(&theirs, "a teammate's note").unwrap();

            let ours = store.create(global_mk(title, "our instructions")).unwrap();
            assert_eq!(ours.slug, taken, "{title}");
            let error = store.promote_to_shared(&ours.id, repo.path()).unwrap_err();
            assert_eq!(
                error,
                "Couldn't share this entry: the shared Knowledge already has a different entry \
                 under the same name. Nothing was changed, here or there. Add a new entry with \
                 the same title, text and tags (it gets a name of its own), share that one, \
                 then delete this one."
            );
            for word in ["slug", "file name", "Rename"] {
                assert!(!error.contains(word), "{word} in {error}");
            }

            // Why "Rename yours" was wrong: a rename keeps the stored name,
            // so the same share is refused again.
            let renamed = store
                .update(
                    MemoryScope::Global,
                    None,
                    &ours.id,
                    MemoryPatch {
                        title: Some(format!("{title} (ours)")),
                        ..Default::default()
                    },
                )
                .unwrap();
            assert_eq!(renamed.slug, taken);
            assert!(store.promote_to_shared(&ours.id, repo.path()).is_err());

            // The advice, step by step: a new entry with the same title and
            // text, shared, then this one deleted.
            let copy = store.create(global_mk(title, "our instructions")).unwrap();
            let shared = store.promote_to_shared(&copy.id, repo.path()).unwrap();
            assert_ne!(shared.slug, taken, "{title}");
            store.delete(MemoryScope::Global, None, &ours.id).unwrap();
            assert_eq!(fs::read(&theirs).unwrap(), b"a teammate's note", "{title}");
            let listed = store.list_shared(repo.path()).unwrap();
            assert!(listed.iter().any(|m| m.id == copy.id && m.body == "our instructions"));
        }
    }

    // ── GH #208: crash-leftover temps are never notes and do not linger ──

    fn age(path: &Path, by: std::time::Duration) {
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(std::time::SystemTime::now() - by).unwrap();
    }

    /// Plant a stale temp, a fresh (in-flight) one, and a directory that
    /// merely has the suffix, beside one real note in `dir`.
    type Planted = (PathBuf, PathBuf, PathBuf, PathBuf, PathBuf);

    fn plant_temps(dir: &Path) -> Planted {
        fs::create_dir_all(dir).unwrap();
        let stale = dir.join("lost.md.atelier-tmp");
        fs::write(&stale, "---\nid: stale\ntitle: Stale\n---\nhalf").unwrap();
        age(&stale, STALE_TEMP_AFTER + std::time::Duration::from_secs(60));
        let fresh = dir.join("busy.md.k3y9.atelier-tmp");
        fs::write(&fresh, "---\nid: fresh\ntitle: Fresh\n---\nwriting").unwrap();
        let not_a_file = dir.join("folder.atelier-tmp");
        fs::create_dir_all(&not_a_file).unwrap();
        // The name `publish_atomic_text` gave its temps before GH #208.
        let legacy = dir.join(".tmpAb12Cd");
        fs::write(&legacy, "half").unwrap();
        age(&legacy, STALE_TEMP_AFTER + std::time::Duration::from_secs(60));
        // Not tempfile's shape (seven characters): never touched.
        let lookalike = dir.join(".tmpAb12Cd7");
        fs::write(&lookalike, "someone's file").unwrap();
        age(&lookalike, STALE_TEMP_AFTER + std::time::Duration::from_secs(60));
        (stale, fresh, not_a_file, legacy, lookalike)
    }

    fn assert_swept(listed: Vec<Memory>, (stale, fresh, not_a_file, legacy, lookalike): Planted) {
        let titles: Vec<String> = listed.into_iter().map(|m| m.title).collect();
        assert_eq!(titles, ["Real"], "a temp is never listed as a note");
        assert!(!stale.exists(), "a stale temp is swept on load");
        assert!(!legacy.exists(), "a stale pre-#208 publish temp is swept too");
        assert!(fresh.exists(), "a temp that may be in flight is kept");
        assert!(not_a_file.is_dir(), "only files are swept");
        assert!(lookalike.exists(), "only tempfile's exact shape is a legacy temp");
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let out = crate::platform::git_command()
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Plyloft Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Plyloft Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// GH #208 review 1: the Project layer is the member's own repository.
    /// A `*.atelier-tmp` (or `.tmpXXXXXX`) somebody committed is their
    /// content, however old: the sweep leaves every tracked file alone and
    /// still removes an untracked leftover beside it.
    #[test]
    fn the_sweep_never_removes_a_file_git_tracks() {
        let cfg = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let repo = tempdir().unwrap();
        git_in(repo.path(), &["init", "-q"]);
        let dir = shared_knowledge_dir(repo.path());
        fs::create_dir_all(&dir).unwrap();
        let committed = dir.join("kept.md.atelier-tmp");
        let committed_legacy = dir.join(".tmpQw12Er");
        for path in [&committed, &committed_legacy] {
            fs::write(path, "committed on purpose").unwrap();
        }
        git_in(repo.path(), &["add", "-A"]);
        git_in(repo.path(), &["commit", "-q", "-m", "tracked temps"]);
        let stray = dir.join("lost.md.atelier-tmp");
        fs::write(&stray, "half").unwrap();
        for path in [&committed, &committed_legacy, &stray] {
            age(path, STALE_TEMP_AFTER + std::time::Duration::from_secs(60));
        }

        store.list_shared(repo.path()).unwrap();
        assert!(committed.exists(), "a tracked file is never swept");
        assert!(committed_legacy.exists(), "a tracked file is never swept");
        assert!(!stray.exists(), "an untracked stale temp beside it still is");
    }

    #[test]
    fn stale_temps_are_swept_and_never_listed_in_every_knowledge_layer() {
        let cfg = tempdir().unwrap();
        let store = MemoryStore::new(cfg.path().to_path_buf()).unwrap();
        let real = store.create(global_mk("Real", "kept")).unwrap();
        let text = encode_memory(&real).unwrap();

        // Personal (Global): swept on the scope's first load.
        let personal = plant_temps(&store.root_path().join(GLOBAL_DIR));
        store.cache.lock().clear();
        assert_swept(store.list(MemoryScope::Global, None).unwrap(), personal);

        // Personal (Workspace).
        let ws_real = store.create(ws_mk("ws-t", "Real", "kept")).unwrap();
        assert_eq!(ws_real.slug, "real");
        let workspace = plant_temps(&store.root_path().join(WORKSPACES_DIR).join("ws-t"));
        store.cache.lock().clear();
        assert_swept(store.list(MemoryScope::Workspace, Some("ws-t")).unwrap(), workspace);

        // Project: the repo's `.atelier/library/knowledge/`.
        let repo = tempdir().unwrap();
        let project_dir = shared_knowledge_dir(repo.path());
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(project_dir.join("real.md"), &text).unwrap();
        let project = plant_temps(&project_dir);
        assert_swept(store.list_shared(repo.path()).unwrap(), project);

        // Team: the team clone's `library/knowledge/`.
        let clone = tempdir().unwrap();
        let team_dir = MemoryStore::team_dir(clone.path());
        fs::create_dir_all(&team_dir).unwrap();
        fs::write(team_dir.join("real.md"), &text).unwrap();
        let team = plant_temps(&team_dir);
        assert_swept(store.list_team(clone.path()).unwrap(), team);
    }
}
