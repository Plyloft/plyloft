//! 1.169.0 (A2): the models and efforts the team suggests for a shared
//! workspace — `.atelier/workspace.json` → `models`, in the shape of the app's
//! rows (`claude` / `codex`, each `builder`, `challenger`, `builderReasoning`,
//! `challengerReasoning`).
//!
//! Like every shared field (ADR 0003, GH #79/#80) it is read live from the
//! integration branch, kept in step on this Mac in
//! `projects/<ws>/team_models.json` (the store a definition refresh writes, as
//! `ply_skills.json` is for `library`), and changed only through the publish
//! queue (`shared_config`) by whoever can push the definition.
//!
//! **Order** (`settings::resolve_model_with_team`): the card's own choice >
//! this Mac's choice for the workspace > the team's suggestion > this Mac's
//! app rows > the tool's default, field by field. A suggestion is a default,
//! never a rule: a choice of one's own always wins, and "the tool's default"
//! forced in the workspace still passes no flag.
//!
//! **Compatibility.** Every key is optional and unknown keys are kept, at the
//! top of `models` and inside each vendor's rows, so a newer file read and
//! written by this build loses nothing; an older Plyloft keeps the whole
//! `models` key untouched (`WorkspaceDefinition::extra`). A value of the
//! wrong type reads as no suggestion rather than an unreadable definition.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::project_config::ProjectConfigStore;
use crate::settings::{cleaned, ClaudeModels, CodexModels, RoleModels};

const FILE: &str = "team_models.json";
const SCHEMA_VERSION: u32 = 1;

/// One vendor's suggested rows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TeamRows {
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "crate::project_config::lenient_opt")]
    pub builder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "crate::project_config::lenient_opt")]
    pub challenger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "crate::project_config::lenient_opt")]
    pub builder_reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "crate::project_config::lenient_opt")]
    pub challenger_reasoning: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl TeamRows {
    pub fn is_empty(&self) -> bool {
        self.builder.is_none()
            && self.challenger.is_none()
            && self.builder_reasoning.is_none()
            && self.challenger_reasoning.is_none()
            && self.extra.is_empty()
    }

    /// Round 3 (S4): the rows a session can take ([`usable`]) — the others
    /// read as no suggestion, for the page and for a spawn alike.
    fn usable_only(&self) -> TeamRows {
        let take = |value: &Option<String>| cleaned(value).filter(|v| usable(v));
        TeamRows {
            builder: take(&self.builder),
            challenger: take(&self.challenger),
            builder_reasoning: take(&self.builder_reasoning),
            challenger_reasoning: take(&self.challenger_reasoning),
            extra: self.extra.clone(),
        }
    }

    fn normalized(&self) -> TeamRows {
        TeamRows {
            builder: cleaned(&self.builder),
            challenger: cleaned(&self.challenger),
            builder_reasoning: cleaned(&self.builder_reasoning),
            challenger_reasoning: cleaned(&self.challenger_reasoning),
            extra: self.extra.clone(),
        }
    }
}

/// `models` in the shared definition.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TeamModels {
    #[serde(skip_serializing_if = "TeamRows::is_empty", deserialize_with = "lenient_rows")]
    pub claude: TeamRows,
    #[serde(skip_serializing_if = "TeamRows::is_empty", deserialize_with = "lenient_rows")]
    pub codex: TeamRows,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn lenient_rows<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<TeamRows, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

impl TeamModels {
    /// No suggestion and no key of a later build.
    pub fn is_empty(&self) -> bool {
        let n = self.normalized();
        n.claude.is_empty() && n.codex.is_empty() && n.extra.is_empty()
    }

    /// Trimmed, blanks dropped; unknown keys kept.
    pub fn normalized(&self) -> TeamModels {
        TeamModels { claude: self.claude.normalized(), codex: self.codex.normalized(), extra: self.extra.clone() }
    }

    /// The suggestions a session can take: every value [`usable`] refuses
    /// reads as none (round 3, S4 — what the page shows is what a spawn uses).
    pub fn usable_only(&self) -> TeamModels {
        TeamModels { claude: self.claude.usable_only(), codex: self.codex.usable_only(), extra: self.extra.clone() }
    }

    /// The suggestions as rows `settings` resolves.
    ///
    /// 1.175.0 (A8, SEC-11): only a value that [`usable`] takes. These come
    /// from a file anyone who can push the branch writes, and each becomes a
    /// flag's value in every session here (`--model`, `--effort`, `-m`,
    /// `-c model_reasoning_effort=`), the read-only Reviewer's too. Any other
    /// value is no suggestion — this computer's own rows decide, as when the
    /// file names none. The file keeps what it holds ([`Self::normalized`]).
    pub fn rows(&self) -> RoleModels {
        let n = self.usable_only();
        RoleModels {
            claude: ClaudeModels {
                builder: n.claude.builder,
                challenger: n.claude.challenger,
                builder_reasoning: n.claude.builder_reasoning,
                challenger_reasoning: n.claude.challenger_reasoning,
            },
            codex: CodexModels {
                builder: n.codex.builder,
                challenger: n.codex.challenger,
                builder_reasoning: n.codex.builder_reasoning,
                challenger_reasoning: n.codex.challenger_reasoning,
            },
        }
    }
}

/// The longest model name or effort a suggestion may be.
const MAX_SUGGESTION_CHARS: usize = 100;

/// A model name or an effort a team's file may suggest: ASCII letters and
/// digits and `. _ : @ / [ ] -` (what the CLIs' own names use — `opus`,
/// `claude-sonnet-4-5[1m]`, `gpt-5.1-codex`, `us.anthropic.claude-…-v1:0`,
/// `xhigh`), at most [`MAX_SUGGESTION_CHARS`], and never starting with `-`,
/// which a CLI would read as a flag of its own.
fn usable(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SUGGESTION_CHARS
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'@' | b'/' | b'[' | b']' | b'-'))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Stored {
    schema_version: u32,
    models: TeamModels,
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

fn path(store: &ProjectConfigStore, workspace_id: &str) -> std::path::PathBuf {
    store.workspace_dir(workspace_id).join(FILE)
}

fn load_stored(store: &ProjectConfigStore, workspace_id: &str) -> Stored {
    let Ok(bytes) = std::fs::read(path(store, workspace_id)) else {
        return Stored::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        // Decides nothing: the next refresh writes the repository's back.
        log::warn!("team models: ignoring unreadable {FILE} for {workspace_id}: {error}");
        Stored::default()
    })
}

/// The team's suggestions for this workspace as this Mac last read them. A
/// missing or unreadable file is no suggestion.
pub fn load(store: &ProjectConfigStore, workspace_id: &str) -> TeamModels {
    load_stored(store, workspace_id).models.normalized()
}

/// Atomic (Hard rule 3). Keeps the file's unknown keys.
pub fn save(store: &ProjectConfigStore, workspace_id: &str, models: &TeamModels) -> Result<(), String> {
    let mut stored = load_stored(store, workspace_id);
    stored.schema_version = SCHEMA_VERSION;
    stored.models = models.normalized();
    crate::atomic::write_atomic_json(&path(store, workspace_id), &stored)
}

/// What the menus read (`team_models_get`): whether the workspace shares a
/// definition at all, whether this Mac can change it, and the suggestions —
/// the same store a spawn reads, so a chip and a spawn always agree.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamModelsView {
    pub shared: bool,
    pub read_only: bool,
    pub models: Option<TeamModels>,
}

/// The view from the stores: a light read (the definition cache's flags and
/// `team_models.json`), no git and no provenance walk. A workspace without a
/// shared definition has no suggestion, whatever an old file says.
pub fn view(store: &ProjectConfigStore, workspace_id: &str) -> TeamModelsView {
    let Some(cache) = crate::workspace_definition::load_cache(store, workspace_id).filter(|c| c.definition.is_some())
    else {
        return TeamModelsView::default();
    };
    // Round 3 (S4): the page gets what a spawn uses — a suggestion that
    // isn't a plain name shows as none there too.
    let models = load(store, workspace_id).usable_only();
    TeamModelsView {
        shared: true,
        read_only: cache.write_access.read_only(),
        models: (!models.is_empty()).then_some(models),
    }
}

/// The team's rows a spawn for `workspace_id` resolves through — none when
/// the store isn't there (early boot, tests), the workspace shares no
/// definition (a leftover file decides nothing), or nothing is suggested.
pub fn for_workspace<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Option<RoleModels> {
    use tauri::Manager;
    let store = app.try_state::<ProjectConfigStore>()?;
    view(&store, workspace_id).models.map(|m| m.rows()).filter(|rows| *rows != RoleModels::default())
}

/// The team's suggestions for the menus, chips and lines.
#[tauri::command]
pub fn team_models_get(store: tauri::State<'_, ProjectConfigStore>, workspace_id: String) -> TeamModelsView {
    view(&store, &workspace_id)
}

/// Tests elsewhere: mark a workspace as sharing a definition (its cache).
#[cfg(test)]
pub(crate) fn share_for_test(store: &ProjectConfigStore, workspace_id: &str, read_only: bool) {
    let path = crate::workspace_definition::cache_path(store, workspace_id);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let access = if read_only { r#","writeAccess":{"canPush":false,"checkedAt":1}"# } else { "" };
    std::fs::write(&path, format!(r#"{{"schemaVersion":1,"definition":{{"name":"w"}}{access}}}"#)).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Challenger 3: a leftover file in a workspace that shares nothing is no
    /// suggestion; the view says shared and read-only from the cache.
    #[test]
    fn only_a_shared_workspace_has_suggestions() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
        let mut team = TeamModels::default();
        team.claude.builder = Some("claude-opus-5-5".into());
        save(&store, "ws", &team).unwrap();
        assert_eq!(view(&store, "ws"), TeamModelsView::default(), "not shared: nothing");
        share_for_test(&store, "ws", false);
        let v = view(&store, "ws");
        assert!(v.shared && !v.read_only);
        assert_eq!(v.models.unwrap().rows().claude.builder.as_deref(), Some("claude-opus-5-5"));
        share_for_test(&store, "ws", true);
        assert!(view(&store, "ws").read_only);
        save(&store, "ws", &TeamModels::default()).unwrap();
        assert_eq!(view(&store, "ws").models, None);
    }

    #[test]
    fn suggestions_read_leniently_and_keep_unknown_keys() {
        let raw = r#"{"claude":{"builder":" claude-opus-5-5 ","builderReasoning":"high","future":1},
                      "codex":{"challenger":7},"teamNote":"x"}"#;
        let team: TeamModels = serde_json::from_str(raw).unwrap();
        let rows = team.rows();
        assert_eq!(rows.claude.builder.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(rows.claude.builder_reasoning.as_deref(), Some("high"));
        assert_eq!(rows.codex.challenger, None, "a number is no suggestion");
        let back = serde_json::to_value(team.normalized()).unwrap();
        assert_eq!(back["claude"]["future"], 1);
        assert_eq!(back["teamNote"], "x");
        assert!(back["codex"].is_null(), "an empty vendor isn't written");
        // A whole value of the wrong type is no suggestion.
        let odd: TeamModels = serde_json::from_str(r#"{"claude":"opus"}"#).unwrap();
        assert_eq!(odd.rows(), RoleModels::default());
        assert_eq!(serde_json::to_value(TeamModels::default()).unwrap(), serde_json::json!({}));
    }

    /// 1.175.0 (A8, SEC-11): a suggestion that isn't a plain model name or
    /// effort is no suggestion here; the file keeps it as it is.
    #[test]
    fn a_suggestion_that_is_not_a_plain_name_is_no_suggestion() {
        for good in ["opus", "claude-sonnet-4-5[1m]", "gpt-5.1-codex-max", "us.anthropic.claude-opus-4-5-v1:0", "claude-opus-4-5@20251101", "openai/gpt-5", "xhigh", "o3"] {
            assert!(usable(good), "{good}");
        }
        let long = "m".repeat(MAX_SUGGESTION_CHARS + 1);
        for bad in ["", "--dangerously-skip-permissions", "-m", "opus --effort max", "opus;rm", "opus\nhigh", "mod$(x)", "modèle", "a|b", "a&b", "\"opus\"", long.as_str()] {
            assert!(!usable(bad), "{bad:?}");
        }
        assert!(usable(&"m".repeat(MAX_SUGGESTION_CHARS)));

        let raw = r#"{"claude":{"builder":"--dangerously-skip-permissions","challenger":"haiku","challengerReasoning":"low; echo"},
                      "codex":{"builder":"gpt-5.1-codex","builderReasoning":"high"}}"#;
        let team: TeamModels = serde_json::from_str(raw).unwrap();
        let rows = team.rows();
        assert_eq!(rows.claude.builder, None, "this computer's own row decides");
        assert_eq!(rows.claude.challenger.as_deref(), Some("haiku"));
        assert_eq!(rows.claude.challenger_reasoning, None);
        assert_eq!(rows.codex.builder.as_deref(), Some("gpt-5.1-codex"));
        assert_eq!(rows.codex.builder_reasoning.as_deref(), Some("high"));
        // The page is handed the same: a chip and a spawn agree.
        let dir = tempfile::tempdir().unwrap();
        let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
        save(&store, "ws", &team).unwrap();
        share_for_test(&store, "ws", false);
        let shown = view(&store, "ws").models.expect("the usable ones");
        assert_eq!(shown.claude.builder, None);
        assert_eq!(shown.claude.challenger.as_deref(), Some("haiku"));
        assert_eq!(shown.claude.challenger_reasoning, None);
        assert_eq!(shown.rows(), rows);
        // Nothing is rewritten or dropped from the file by reading it.
        let back = serde_json::to_value(team.normalized()).unwrap();
        assert_eq!(back["claude"]["builder"], "--dangerously-skip-permissions");
        assert_eq!(back["claude"]["challengerReasoning"], "low; echo");
    }

    #[test]
    fn the_store_round_trips_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProjectConfigStore::new(dir.path().to_path_buf()).unwrap();
        assert_eq!(load(&store, "ws"), TeamModels::default());
        let mut team = TeamModels::default();
        team.codex.builder = Some("gpt-6-astra".into());
        save(&store, "ws", &team).unwrap();
        assert_eq!(load(&store, "ws").rows().codex.builder.as_deref(), Some("gpt-6-astra"));
        std::fs::write(path(&store, "ws"), "{broken").unwrap();
        assert_eq!(load(&store, "ws"), TeamModels::default());
    }
}
