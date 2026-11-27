//! v1.68.0 (UX revamp step 3b — Knowledge merge, decision card #7): the
//! one-time, NON-DESTRUCTIVE migration into the unified Knowledge store
//! (the extended memory store — see `memory.rs::KnowledgeType`).
//!
//! Contract (card #7, verbatim): "The migration only tags + re-homes
//! records and de-dupes; nothing is deleted. Cards keep their
//! attachments; a card can attach any entry or promote an inline note
//! into the store."
//!
//! What it does, once (sentinel-guarded):
//! - Personal prompts (`prompts/library.json`) → Global entries with
//!   `entry_type = Prompt` (+ system_prompt / prompt_template payload).
//!   The source file is NOT deleted; the team-shared layer
//!   (`<cwd>/.atelier/library/prompts.json`) is untouched entirely.
//! - Per-card `knowledge` → Workspace-scoped `Note` entries linked to
//!   their card (`linked_cards = [card_id]`, source carries the card).
//!   The card's inline field STAYS — it remains the inline note the
//!   card UI shows; the store entry makes the content findable.
//!
//! Best-effort throughout: a failure on any single record logs and
//! continues; a failure to write the sentinel just means a re-run next
//! launch, which the de-dupe makes harmless. Mirrors the F1
//! snapshot-capture and v1.61.0 import-queue patterns.

use std::path::Path;

use crate::kanban::KanbanStore;
use crate::memory::{KnowledgeType, MemoryScope, MemorySource, MemoryStore, NewMemory};
use crate::prompts::PromptsStore;

const SENTINEL: &str = "knowledge_migrated";

/// Run the migration if the sentinel is absent. Returns
/// `(prompts_migrated, card_notes_migrated)`; `(0, 0)` on the no-op path.
pub fn run_once(
    config_dir: &Path,
    workspace_ids: &[String],
    prompts: &PromptsStore,
    memory: &MemoryStore,
    kanban: &KanbanStore,
) -> (usize, usize) {
    let sentinel = config_dir.join(SENTINEL);
    if sentinel.exists() {
        return (0, 0);
    }

    let mut prompts_migrated = 0usize;
    let mut notes_migrated = 0usize;

    // ── Personal prompts → Global prompt-type entries ───────────────
    match prompts.list() {
        Ok(list) => {
            let existing_global = memory.list(MemoryScope::Global, None).unwrap_or_default();
            for p in list {
                // De-dupe by case-insensitive title within the Global scope —
                // a re-run (sentinel write failed) must not duplicate.
                let title_lc = p.name.to_lowercase();
                if existing_global
                    .iter()
                    .any(|m| m.title.to_lowercase() == title_lc)
                {
                    continue;
                }
                let new = NewMemory {
                    title: p.name.clone(),
                    body: p.description.clone(),
                    scope: MemoryScope::Global,
                    workspace_id: None,
                    tags: p.tags.clone(),
                    linked_cards: Vec::new(),
                    source: MemorySource::Manual,
                    entry_type: KnowledgeType::Prompt,
                    system_prompt: Some(p.system_prompt.clone())
                        .filter(|s| !s.trim().is_empty()),
                    prompt_template: Some(p.prompt_template.clone())
                        .filter(|s| !s.trim().is_empty()),
                    evidence: None,
                };
                match memory.create(new) {
                    Ok(_) => prompts_migrated += 1,
                    Err(e) => log::warn!("knowledge migration: prompt '{}': {e}", p.name),
                }
            }
        }
        Err(e) => log::warn!("knowledge migration: prompts list failed: {e}"),
    }

    // ── Per-card knowledge → Workspace note entries (card-linked) ───
    for ws_id in workspace_ids {
        let cards = match kanban.load(ws_id) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("knowledge migration: kanban load {ws_id}: {e}");
                continue;
            }
        };
        let existing = memory
            .list(MemoryScope::Workspace, Some(ws_id))
            .unwrap_or_default();
        for card in cards {
            let Some(knowledge) = card.knowledge.as_deref() else {
                continue;
            };
            if knowledge.trim().is_empty() {
                continue;
            }
            // De-dupe: skip when an entry already carries this card's
            // knowledge (same body + linked to this card).
            if existing.iter().any(|m| {
                m.linked_cards.iter().any(|c| c == &card.id) && m.body == knowledge
            }) {
                continue;
            }
            let title = format!("Card · {}", truncate_chars(&card.title, 60));
            let new = NewMemory {
                title,
                body: knowledge.to_string(),
                scope: MemoryScope::Workspace,
                workspace_id: Some(ws_id.clone()),
                tags: vec!["card-knowledge".to_string()],
                linked_cards: vec![card.id.clone()],
                // Suggested-with-card provenance: the entry "came from
                // card X" — the same shape accepted suggestions use.
                source: MemorySource::Suggested {
                    run_id: None,
                    card_id: Some(card.id.clone()),
                },
                entry_type: KnowledgeType::Note,
                system_prompt: None,
                prompt_template: None,
                evidence: None,
            };
            match memory.create(new) {
                Ok(_) => notes_migrated += 1,
                Err(e) => {
                    log::warn!("knowledge migration: card '{}': {e}", card.id)
                }
            }
        }
    }

    if let Err(e) = std::fs::write(&sentinel, chrono::Utc::now().to_rfc3339()) {
        // Non-fatal: the de-dupe above makes a re-run harmless.
        log::warn!("knowledge migration: sentinel write failed: {e}");
    }
    log::info!(
        "knowledge migration: {prompts_migrated} prompt(s) + {notes_migrated} card note(s) re-homed (nothing deleted)"
    );
    (prompts_migrated, notes_migrated)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kanban::{KanbanCard, KanbanColumnId};
    use tempfile::TempDir;

    fn fixture_stores(dir: &TempDir) -> (PromptsStore, MemoryStore, KanbanStore) {
        let cfg = dir.path().to_path_buf();
        // Personal prompts fixture — the v1 library.json shape.
        let prompts_dir = cfg.join("prompts");
        std::fs::create_dir_all(&prompts_dir).unwrap();
        std::fs::write(
            prompts_dir.join("library.json"),
            br#"{
              "version": 1,
              "prompts": [{
                "id": "p1",
                "name": "House style",
                "description": "How we write code here",
                "systemPrompt": "Always terse.",
                "promptTemplate": "Do {{thing}}",
                "tags": ["style"],
                "createdAt": 1,
                "updatedAt": 2
              }]
            }"#,
        )
        .unwrap();
        let prompts = PromptsStore::new(cfg.clone()).unwrap();
        let memory = MemoryStore::new(cfg.clone()).unwrap();
        let kanban = KanbanStore::new(cfg).unwrap();
        // Card with inline knowledge.
        let mut card = KanbanCard::new(
            "c1".into(),
            "ws1".into(),
            "CSV export".into(),
            None,
            KanbanColumnId::Todo,
        );
        card.knowledge = Some("Stream rows server-side.".into());
        kanban.save("ws1", vec![card]).unwrap();
        (prompts, memory, kanban)
    }

    #[test]
    fn migration_rehomes_prompts_and_card_knowledge_nondestructively() {
        let dir = TempDir::new().unwrap();
        let (prompts, memory, kanban) = fixture_stores(&dir);
        let (p, n) = run_once(
            dir.path(),
            &["ws1".to_string()],
            &prompts,
            &memory,
            &kanban,
        );
        assert_eq!((p, n), (1, 1));

        // Prompt landed as a Global prompt-type entry with payload.
        let global = memory.list(MemoryScope::Global, None).unwrap();
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].title, "House style");
        assert_eq!(global[0].entry_type, KnowledgeType::Prompt);
        assert_eq!(global[0].system_prompt.as_deref(), Some("Always terse."));

        // Card knowledge landed as a Workspace note linked to the card —
        // and the card's inline field is UNTOUCHED.
        let ws = memory.list(MemoryScope::Workspace, Some("ws1")).unwrap();
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].entry_type, KnowledgeType::Note);
        assert_eq!(ws[0].linked_cards, vec!["c1".to_string()]);
        let cards = kanban.load("ws1").unwrap();
        assert_eq!(
            cards[0].knowledge.as_deref(),
            Some("Stream rows server-side.")
        );

        // Source files survive (nothing is deleted).
        assert!(dir.path().join("prompts").join("library.json").exists());
        // Sentinel written.
        assert!(dir.path().join(SENTINEL).exists());
    }

    #[test]
    fn migration_is_idempotent_via_sentinel_and_dedupe() {
        let dir = TempDir::new().unwrap();
        let (prompts, memory, kanban) = fixture_stores(&dir);
        run_once(dir.path(), &["ws1".to_string()], &prompts, &memory, &kanban);
        // Second run: sentinel short-circuits.
        let (p2, n2) = run_once(
            dir.path(),
            &["ws1".to_string()],
            &prompts,
            &memory,
            &kanban,
        );
        assert_eq!((p2, n2), (0, 0));

        // Even WITHOUT the sentinel (simulated failed write), the
        // de-dupe keeps the stores clean.
        std::fs::remove_file(dir.path().join(SENTINEL)).unwrap();
        let (p3, n3) = run_once(
            dir.path(),
            &["ws1".to_string()],
            &prompts,
            &memory,
            &kanban,
        );
        assert_eq!((p3, n3), (0, 0));
        assert_eq!(memory.list(MemoryScope::Global, None).unwrap().len(), 1);
        assert_eq!(
            memory
                .list(MemoryScope::Workspace, Some("ws1"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn legacy_memory_file_loads_as_note_with_no_prompt_payload() {
        // Tier-2: a pre-v1.68 memory file (no entryType / systemPrompt /
        // promptTemplate keys) must load with the defaults.
        let dir = TempDir::new().unwrap();
        let ws_dir = dir
            .path()
            .join("memory")
            .join("workspaces")
            .join("ws1");
        std::fs::create_dir_all(&ws_dir).unwrap();
        std::fs::write(
            ws_dir.join("old-note.md"),
            "---\nschemaVersion: 1\nid: m1\ntitle: Old note\ncreatedAt: \"2026-01-01T00:00:00Z\"\nupdatedAt: \"2026-01-01T00:00:00Z\"\n---\nbody text",
        )
        .unwrap();
        let memory = MemoryStore::new(dir.path().to_path_buf()).unwrap();
        let items = memory.list(MemoryScope::Workspace, Some("ws1")).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].entry_type, KnowledgeType::Note);
        assert!(items[0].system_prompt.is_none());
        assert!(items[0].prompt_template.is_none());
        assert_eq!(items[0].body, "body text");
    }
}
