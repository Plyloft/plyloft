//! Canonical, read-only provenance types for evidence-backed Knowledge.
//!
//! Tauri constructs these records from Git and its persisted operational
//! artifacts. This crate owns only bounded value types and pure helpers so
//! accepted Markdown and the read-only MCP sidecar cannot drift.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const EVIDENCE_SCHEMA_VERSION: u32 = 1;
pub const MAX_EVIDENCE_CHANGED_PATHS: usize = 1_000;
pub const MAX_EVIDENCE_IDS_PER_CLASS: usize = 256;
pub const MAX_EVIDENCE_RAW_STAT_BYTES: usize = 16 * 1024;
pub const MAX_ACCEPTED_DIFF_EXCERPT_BYTES: usize = 16 * 1024;
pub const MAX_ACCEPTED_ENVELOPE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceAttribution {
    IsolatedCard,
    #[default]
    LegacyCheckout,
    SharedBatch,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidencePathStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPathEvidence {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(default)]
    pub status: EvidencePathStatus,
    #[serde(default)]
    pub lossy: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStatEvidence {
    #[serde(default)]
    pub files_changed: u64,
    #[serde(default)]
    pub insertions: u64,
    #[serde(default)]
    pub deletions: u64,
    #[serde(default)]
    pub raw: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEvidence {
    pub base_revision: String,
    pub head_revision: String,
    pub range: String,
    pub sha256: String,
    #[serde(default)]
    pub byte_count: u64,
    #[serde(default)]
    pub stat: DiffStatEvidence,
    #[serde(default)]
    pub changed_paths: Vec<ChangedPathEvidence>,
    #[serde(default)]
    pub changed_path_count: u64,
    #[serde(default)]
    pub paths_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt_same_as: Option<String>,
    #[serde(default)]
    pub excerpt_byte_count: u64,
    #[serde(default)]
    pub excerpt_truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipEvidence {
    pub commit_sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_revision: Option<String>,
    #[serde(default)]
    pub release_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shipped_version: Option<String>,
    #[serde(default)]
    pub shipped_at: i64,
    #[serde(default)]
    pub attribution: EvidenceAttribution,
    #[serde(default)]
    pub batch_card_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEvidence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_ref: Option<String>,
    pub base_revision: String,
    pub head_revision: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationRevisionBinding {
    Exact,
    PreShipUnbound,
    Legacy,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationStepEvidence {
    pub kind: String,
    pub passed: bool,
    #[serde(default)]
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationArtifactEvidence {
    pub verify_run_id: String,
    pub status: String,
    #[serde(default)]
    pub ended_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub steps: Vec<VerificationStepEvidence>,
    #[serde(default)]
    pub skipped: bool,
    #[serde(default)]
    pub revision_binding: VerificationRevisionBinding,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerArtifactEvidence {
    pub review_id: String,
    pub provider: String,
    pub provider_version: String,
    pub capability: String,
    pub base_revision: String,
    pub head_revision: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<serde_json::Value>,
    #[serde(default)]
    pub artifact_sha256: String,
    #[serde(default)]
    pub artifact_byte_count: u64,
    #[serde(default)]
    pub artifact_truncated: bool,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub write_escaped: bool,
    #[serde(default)]
    pub excluded_dirty_paths: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionArtifactEvidence {
    pub discussion_id: String,
    #[serde(default)]
    pub participant_versions: Vec<String>,
    #[serde(default)]
    pub synthesizer: String,
    pub pinned_revision: String,
    #[serde(default)]
    pub completed_at: i64,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub result_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_excerpt: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synthesis_summary: Option<String>,
    #[serde(default)]
    pub disagreement_count: u64,
    #[serde(default)]
    pub unresolved: Vec<DiscussionUnresolvedEvidence>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionUnresolvedEvidence {
    pub id: String,
    pub statement: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffArtifactEvidence {
    pub handoff_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swarm_id: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceIdentifiers {
    #[serde(default)]
    pub card_ids: Vec<String>,
    #[serde(default)]
    pub card_id_count: u64,
    #[serde(default)]
    pub card_ids_sha256: String,
    #[serde(default)]
    pub card_ids_truncated: bool,
    #[serde(default)]
    pub run_ids: Vec<String>,
    #[serde(default)]
    pub run_id_count: u64,
    #[serde(default)]
    pub run_ids_sha256: String,
    #[serde(default)]
    pub run_ids_truncated: bool,
    #[serde(default)]
    pub swarm_ids: Vec<String>,
    #[serde(default)]
    pub swarm_id_count: u64,
    #[serde(default)]
    pub swarm_ids_sha256: String,
    #[serde(default)]
    pub swarm_ids_truncated: bool,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub session_id_count: u64,
    #[serde(default)]
    pub session_ids_sha256: String,
    #[serde(default)]
    pub session_ids_truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEvidenceEnvelope {
    pub schema_version: u32,
    pub proposal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion_id: Option<String>,
    #[serde(default)]
    pub captured_at: i64,
    #[serde(default = "shipped_change_kind")]
    pub provenance_kind: String,
    #[serde(default)]
    pub ship: ShipEvidence,
    #[serde(default)]
    pub source: SourceEvidence,
    #[serde(default)]
    pub change_diff: DiffEvidence,
    #[serde(default)]
    pub landed_diff: DiffEvidence,
    #[serde(default)]
    pub verification_artifacts: Vec<VerificationArtifactEvidence>,
    #[serde(default)]
    pub reviewer_artifacts: Vec<ReviewerArtifactEvidence>,
    #[serde(default)]
    pub discussion_artifacts: Vec<DiscussionArtifactEvidence>,
    #[serde(default)]
    pub handoff_artifacts: Vec<HandoffArtifactEvidence>,
    #[serde(default)]
    pub ids: EvidenceIdentifiers,
}

fn shipped_change_kind() -> String {
    "shipped_change".to_string()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CitationKind {
    Path,
    Diff,
    Verification,
    Review,
    Discussion,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCitation {
    #[serde(default)]
    pub kind: CitationKind,
    pub reference: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CitationResolution {
    Matched,
    Unresolved,
    HistoricalStale,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEvidenceSummary {
    pub proposal_id: String,
    pub commit_sha: String,
    #[serde(default)]
    pub changed_path_count: u64,
    #[serde(default)]
    pub verification_count: u64,
    #[serde(default)]
    pub reviewer_count: u64,
    #[serde(default)]
    pub discussion_count: u64,
    #[serde(default)]
    pub change_diff_sha256: String,
    #[serde(default)]
    pub landed_diff_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedText {
    pub text: String,
    pub byte_count: usize,
    pub truncated: bool,
    pub lossy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedChangedPaths {
    pub paths: Vec<ChangedPathEvidence>,
    pub count: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedOpaqueIds {
    pub ids: Vec<String>,
    pub count: usize,
    pub sha256: String,
    pub truncated: bool,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn bounded_lossy_text(bytes: &[u8], max_bytes: usize) -> BoundedText {
    let lossy = std::str::from_utf8(bytes).is_err();
    let rendered = String::from_utf8_lossy(bytes);
    if rendered.len() <= max_bytes {
        return BoundedText {
            text: rendered.into_owned(),
            byte_count: bytes.len(),
            truncated: false,
            lossy,
        };
    }
    let mut boundary = max_bytes.min(rendered.len());
    while boundary > 0 && !rendered.is_char_boundary(boundary) {
        boundary -= 1;
    }
    BoundedText {
        text: rendered[..boundary].to_string(),
        byte_count: bytes.len(),
        truncated: true,
        lossy,
    }
}

pub fn bound_changed_paths(
    mut paths: Vec<ChangedPathEvidence>,
    limit: usize,
) -> BoundedChangedPaths {
    paths.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.old_path.cmp(&right.old_path))
    });
    paths.dedup();
    let count = paths.len();
    let truncated = count > limit;
    paths.truncate(limit);
    BoundedChangedPaths {
        paths,
        count,
        truncated,
    }
}

pub fn bound_opaque_ids(values: Vec<String>, limit: usize) -> BoundedOpaqueIds {
    let mut values = values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    let count = values.len();
    let mut digest_input = Vec::new();
    for value in &values {
        digest_input.extend_from_slice(value.as_bytes());
        digest_input.push(0);
    }
    let sha256 = sha256_hex(&digest_input);
    let truncated = count > limit;
    values.truncate(limit);
    BoundedOpaqueIds {
        ids: values,
        count,
        sha256,
        truncated,
    }
}

pub fn normalize_repo_path(raw: &str) -> Result<String, String> {
    if raw.contains('\0') {
        return Err("repository path contains NUL".to_string());
    }
    let replaced = raw.replace('\\', "/");
    if replaced.starts_with('/') || replaced.as_bytes().get(1) == Some(&b':') {
        return Err(format!("repository path must be relative: {raw:?}"));
    }
    let mut normalized = Vec::new();
    for component in replaced.split('/') {
        match component {
            "" | "." => {}
            ".." => return Err(format!("repository path escapes root: {raw:?}")),
            value => normalized.push(value),
        }
    }
    if normalized.is_empty() {
        return Err("repository path is empty".to_string());
    }
    Ok(normalized.join("/"))
}

pub fn derive_attribution(
    has_isolated_source: bool,
    batch_card_count: usize,
) -> EvidenceAttribution {
    if has_isolated_source {
        EvidenceAttribution::IsolatedCard
    } else if batch_card_count > 1 {
        EvidenceAttribution::SharedBatch
    } else {
        EvidenceAttribution::LegacyCheckout
    }
}

pub fn evidence_summary(envelope: &KnowledgeEvidenceEnvelope) -> KnowledgeEvidenceSummary {
    KnowledgeEvidenceSummary {
        proposal_id: envelope.proposal_id.clone(),
        commit_sha: envelope.ship.commit_sha.clone(),
        changed_path_count: envelope
            .landed_diff
            .changed_path_count
            .max(envelope.change_diff.changed_path_count),
        verification_count: envelope.verification_artifacts.len() as u64,
        reviewer_count: envelope.reviewer_artifacts.len() as u64,
        discussion_count: envelope.discussion_artifacts.len() as u64,
        change_diff_sha256: envelope.change_diff.sha256.clone(),
        landed_diff_sha256: envelope.landed_diff.sha256.clone(),
    }
}

pub fn validate_evidence_envelope_budget(
    envelope: &KnowledgeEvidenceEnvelope,
) -> Result<usize, String> {
    let encoded = serde_json::to_vec(envelope)
        .map_err(|error| format!("serialize evidence envelope: {error}"))?;
    if encoded.len() > MAX_ACCEPTED_ENVELOPE_BYTES {
        return Err(format!(
            "evidence_budget_exceeded: {} bytes exceeds {}",
            encoded.len(),
            MAX_ACCEPTED_ENVELOPE_BYTES
        ));
    }
    Ok(encoded.len())
}

pub fn resolve_citation(
    citation: &ModelCitation,
    envelope: &KnowledgeEvidenceEnvelope,
    historically_stale_refs: &HashSet<String>,
) -> CitationResolution {
    let reference = citation.reference.trim();
    let matched = match citation.kind {
        CitationKind::Path => normalize_repo_path(reference).ok().is_some_and(|path| {
            envelope
                .change_diff
                .changed_paths
                .iter()
                .chain(envelope.landed_diff.changed_paths.iter())
                .any(|entry| entry.path == path || entry.old_path.as_deref() == Some(path.as_str()))
        }),
        CitationKind::Diff => {
            reference == envelope.change_diff.sha256
                || reference == envelope.landed_diff.sha256
                || reference == envelope.change_diff.range
                || reference == envelope.landed_diff.range
                || reference == envelope.ship.commit_sha
        }
        CitationKind::Verification => envelope
            .verification_artifacts
            .iter()
            .any(|entry| entry.verify_run_id == reference),
        CitationKind::Review => envelope
            .reviewer_artifacts
            .iter()
            .any(|entry| entry.review_id == reference),
        CitationKind::Discussion => envelope
            .discussion_artifacts
            .iter()
            .any(|entry| entry.discussion_id == reference),
        CitationKind::Unknown => false,
    };
    if !matched {
        CitationResolution::Unresolved
    } else if historically_stale_refs.contains(reference) {
        CitationResolution::HistoricalStale
    } else {
        CitationResolution::Matched
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier2_minimal_envelope_defaults_and_round_trips() {
        let legacy = br#"{
            "schemaVersion": 1,
            "proposalId": "proposal-1"
        }"#;
        let parsed: KnowledgeEvidenceEnvelope = serde_json::from_slice(legacy).unwrap();
        assert_eq!(parsed.schema_version, 1);
        assert_eq!(parsed.provenance_kind, "shipped_change");
        assert!(parsed.verification_artifacts.is_empty());
        assert_eq!(parsed.ship.attribution, EvidenceAttribution::LegacyCheckout);

        let encoded = serde_json::to_vec(&parsed).unwrap();
        let round_trip: KnowledgeEvidenceEnvelope = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(round_trip, parsed);
    }

    #[test]
    fn bounded_lossy_text_preserves_char_boundaries_and_reports_source_bytes() {
        let source = b"alpha \xff beta \xe2\x98\x83 gamma";
        let bounded = bounded_lossy_text(source, 12);
        assert!(bounded.lossy);
        assert!(bounded.truncated);
        assert_eq!(bounded.byte_count, source.len());
        assert!(std::str::from_utf8(bounded.text.as_bytes()).is_ok());
        assert!(bounded.text.len() <= 12);
    }

    #[test]
    fn repository_path_normalization_rejects_escapes_and_absolutes() {
        assert_eq!(normalize_repo_path("./src\\lib.rs").unwrap(), "src/lib.rs");
        assert!(normalize_repo_path("../secret").is_err());
        assert!(normalize_repo_path("/tmp/secret").is_err());
        assert!(normalize_repo_path("C:\\secret").is_err());
        assert!(normalize_repo_path("").is_err());
    }

    #[test]
    fn attribution_never_invents_per_card_ownership() {
        assert_eq!(
            derive_attribution(true, 4),
            EvidenceAttribution::IsolatedCard
        );
        assert_eq!(
            derive_attribution(false, 1),
            EvidenceAttribution::LegacyCheckout
        );
        assert_eq!(
            derive_attribution(false, 2),
            EvidenceAttribution::SharedBatch
        );
    }

    #[test]
    fn path_and_identifier_bounds_are_sorted_deduplicated_and_explicit() {
        let paths = (0..1_002)
            .rev()
            .map(|index| ChangedPathEvidence {
                path: format!("src/{index:04}.rs"),
                ..ChangedPathEvidence::default()
            })
            .chain(std::iter::once(ChangedPathEvidence {
                path: "src/0000.rs".into(),
                ..ChangedPathEvidence::default()
            }))
            .collect();
        let bounded = bound_changed_paths(paths, 1_000);
        assert_eq!(bounded.count, 1_002);
        assert_eq!(bounded.paths.len(), 1_000);
        assert!(bounded.truncated);
        assert_eq!(bounded.paths[0].path, "src/0000.rs");

        let ids = bound_opaque_ids(vec!["b".into(), "a".into(), "a".into(), " ".into()], 1);
        assert_eq!(ids.count, 2);
        assert_eq!(ids.ids, vec!["a"]);
        assert!(ids.truncated);
        assert_eq!(ids.sha256.len(), 64);
    }

    #[test]
    fn citations_are_resolved_as_enrichment_only() {
        let mut envelope = KnowledgeEvidenceEnvelope {
            schema_version: 1,
            proposal_id: "p".into(),
            ship: ShipEvidence {
                commit_sha: "abc".into(),
                ..ShipEvidence::default()
            },
            ..KnowledgeEvidenceEnvelope::default()
        };
        envelope.change_diff.sha256 = "diff-sha".into();
        envelope
            .change_diff
            .changed_paths
            .push(ChangedPathEvidence {
                path: "src/lib.rs".into(),
                ..ChangedPathEvidence::default()
            });
        envelope.reviewer_artifacts.push(ReviewerArtifactEvidence {
            review_id: "review-1".into(),
            ..ReviewerArtifactEvidence::default()
        });
        envelope
            .discussion_artifacts
            .push(DiscussionArtifactEvidence {
                discussion_id: "discussion-1".into(),
                ..DiscussionArtifactEvidence::default()
            });

        let none = HashSet::new();
        assert_eq!(
            resolve_citation(
                &ModelCitation {
                    kind: CitationKind::Path,
                    reference: "src/lib.rs".into(),
                    note: None,
                },
                &envelope,
                &none,
            ),
            CitationResolution::Matched
        );
        assert_eq!(
            resolve_citation(
                &ModelCitation {
                    kind: CitationKind::Review,
                    reference: "missing".into(),
                    note: None,
                },
                &envelope,
                &none,
            ),
            CitationResolution::Unresolved
        );
        let stale = HashSet::from(["discussion-1".to_string()]);
        assert_eq!(
            resolve_citation(
                &ModelCitation {
                    kind: CitationKind::Discussion,
                    reference: "discussion-1".into(),
                    note: None,
                },
                &envelope,
                &stale,
            ),
            CitationResolution::HistoricalStale
        );
    }

    #[test]
    fn summary_excludes_full_artifact_and_excerpt_content() {
        let envelope = KnowledgeEvidenceEnvelope {
            schema_version: 1,
            proposal_id: "p".into(),
            ship: ShipEvidence {
                commit_sha: "commit".into(),
                ..ShipEvidence::default()
            },
            change_diff: DiffEvidence {
                sha256: "change".into(),
                changed_path_count: 2,
                excerpt: Some("source code that must not enter search".into()),
                ..DiffEvidence::default()
            },
            landed_diff: DiffEvidence {
                sha256: "landed".into(),
                changed_path_count: 3,
                ..DiffEvidence::default()
            },
            reviewer_artifacts: vec![ReviewerArtifactEvidence {
                artifact: Some(serde_json::json!({"secret": "full artifact"})),
                ..ReviewerArtifactEvidence::default()
            }],
            ..KnowledgeEvidenceEnvelope::default()
        };
        let summary = evidence_summary(&envelope);
        let json = serde_json::to_string(&summary).unwrap();
        assert_eq!(summary.changed_path_count, 3);
        assert!(!json.contains("source code"));
        assert!(!json.contains("full artifact"));
    }

    #[test]
    fn envelope_budget_fails_without_silently_dropping_evidence() {
        let envelope = KnowledgeEvidenceEnvelope {
            schema_version: 1,
            proposal_id: "p".into(),
            change_diff: DiffEvidence {
                excerpt: Some("x".repeat(MAX_ACCEPTED_ENVELOPE_BYTES)),
                ..DiffEvidence::default()
            },
            ..KnowledgeEvidenceEnvelope::default()
        };
        let error = validate_evidence_envelope_budget(&envelope).unwrap_err();
        assert!(error.contains("evidence_budget_exceeded"));
        assert_eq!(
            envelope.change_diff.excerpt.as_deref().unwrap().len(),
            MAX_ACCEPTED_ENVELOPE_BYTES
        );
    }
}
