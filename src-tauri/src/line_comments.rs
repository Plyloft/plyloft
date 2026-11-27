//! SL-5 (ship loop): line comments on a card's review diff.
//!
//! The person selects one or more lines of the card's diff (the review
//! panel), writes a comment, and the comments collect on the card until
//! **Send to Builder** pastes them, all in one message, into the card's
//! Builder session. Sent comments are kept as the card's history. They stay
//! in Plyloft: nothing here, or anywhere they are read, posts to GitHub.
//!
//! Line references: added and context lines are named by their line number
//! in the card's version of the file (`new_start..=new_end`); removed lines
//! exist only in the base version, so a selection holding removed lines also
//! names their numbers there (`old_start..=old_end`). A selection of only
//! removed lines has no new-file range. The frontend computes both from the
//! diff (`src/lib/lineComments.ts`); this module stores and validates them.
//!
//! Persisted on the card (`KanbanCard::line_comments`, serde default, not
//! written when empty — an old board loads unchanged). Every write goes
//! through `KanbanStore`'s atomic load → mutate → tempfile + rename.

use serde::{Deserialize, Serialize};

/// Longest comment accepted, in characters.
pub const MAX_BODY_CHARS: usize = 10_000;
/// Longest quoted excerpt stored with a comment, in characters. The
/// frontend trims a long selection's quote before it gets here.
pub const MAX_QUOTED_CHARS: usize = 20_000;
/// Unsent comments a card holds at most.
pub const MAX_UNSENT: usize = 200;

/// One comment on a range of the card's diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineComment {
    pub id: String,
    /// The file's path in the card's version (a rename's new path).
    pub path: String,
    /// First and last line in the card's version of the file covered by the
    /// selection's added and context lines. `None` when the selection holds
    /// removed lines only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_start: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_end: Option<u32>,
    /// First and last removed line of the selection, numbered in the base
    /// version of the file. `None` when it holds no removed line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_start: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_end: Option<u32>,
    /// The selected diff lines as shown (`+`, `-` or space prefix), with a
    /// `…` line where the selection crosses from one hunk to the next.
    #[serde(default)]
    pub quoted: String,
    pub body: String,
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    /// When it was pasted into the Builder session. `None` = not sent yet:
    /// editable and removable. Sent comments are history, read-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_at: Option<i64>,
}

/// What the frontend sends to add a comment; the id and times are the
/// backend's.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineCommentDraft {
    pub path: String,
    #[serde(default)]
    pub new_start: Option<u32>,
    #[serde(default)]
    pub new_end: Option<u32>,
    #[serde(default)]
    pub old_start: Option<u32>,
    #[serde(default)]
    pub old_end: Option<u32>,
    #[serde(default)]
    pub quoted: String,
    pub body: String,
}

fn check_body(body: &str) -> Result<String, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("the comment is empty".to_string());
    }
    if trimmed.chars().count() > MAX_BODY_CHARS {
        return Err(format!("the comment is longer than {MAX_BODY_CHARS} characters"));
    }
    Ok(trimmed.to_string())
}

fn check_range(start: Option<u32>, end: Option<u32>, which: &str) -> Result<(), String> {
    match (start, end) {
        (None, None) => Ok(()),
        (Some(s), Some(e)) if s >= 1 && s <= e => Ok(()),
        _ => Err(format!("the {which} line range is not valid")),
    }
}

/// Validate a draft into a new, unsent comment.
pub fn comment_from_draft(draft: LineCommentDraft, id: String, now: i64) -> Result<LineComment, String> {
    let path = draft.path.trim().to_string();
    if path.is_empty() {
        return Err("a line comment needs the file it is about".to_string());
    }
    check_range(draft.new_start, draft.new_end, "new-file")?;
    check_range(draft.old_start, draft.old_end, "removed")?;
    if draft.new_start.is_none() && draft.old_start.is_none() {
        return Err("a line comment needs at least one line".to_string());
    }
    if draft.quoted.chars().count() > MAX_QUOTED_CHARS {
        return Err(format!("the quoted lines are longer than {MAX_QUOTED_CHARS} characters"));
    }
    Ok(LineComment {
        id,
        path,
        new_start: draft.new_start,
        new_end: draft.new_end,
        old_start: draft.old_start,
        old_end: draft.old_end,
        quoted: draft.quoted,
        body: check_body(&draft.body)?,
        created_at: now,
        updated_at: now,
        sent_at: None,
    })
}

/// Append a new comment; refused past `MAX_UNSENT` unsent ones.
pub fn add(list: &mut Vec<LineComment>, comment: LineComment) -> Result<(), String> {
    if list.iter().filter(|c| c.sent_at.is_none()).count() >= MAX_UNSENT {
        return Err(format!(
            "this card already holds {MAX_UNSENT} comments not sent yet; send or remove some first"
        ));
    }
    list.push(comment);
    Ok(())
}

fn unsent_mut<'a>(list: &'a mut [LineComment], id: &str) -> Result<&'a mut LineComment, String> {
    let c = list
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| "that comment is no longer on the card".to_string())?;
    if c.sent_at.is_some() {
        return Err("that comment was already sent to the Builder; sent comments are kept as they were".to_string());
    }
    Ok(c)
}

/// Change an unsent comment's text.
pub fn update(list: &mut [LineComment], id: &str, body: &str, now: i64) -> Result<(), String> {
    let body = check_body(body)?;
    let c = unsent_mut(list, id)?;
    c.body = body;
    c.updated_at = now;
    Ok(())
}

/// Remove an unsent comment.
pub fn remove(list: &mut Vec<LineComment>, id: &str) -> Result<(), String> {
    unsent_mut(list, id)?;
    list.retain(|c| c.id != id);
    Ok(())
}

/// Mark the given comments sent at `now`. Only unsent ones change: a comment
/// already sent keeps its first time, and an id no longer on the card is
/// skipped (it was removed meanwhile). Returns how many were marked.
pub fn mark_sent(list: &mut [LineComment], ids: &[String], now: i64) -> usize {
    let mut n = 0;
    for c in list.iter_mut() {
        if c.sent_at.is_none() && ids.iter().any(|id| id == &c.id) {
            c.sent_at = Some(now);
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(body: &str) -> LineCommentDraft {
        LineCommentDraft {
            path: "src/a.ts".into(),
            new_start: Some(3),
            new_end: Some(5),
            old_start: None,
            old_end: None,
            quoted: "+a\n+b\n c".into(),
            body: body.into(),
        }
    }

    #[test]
    fn a_draft_becomes_an_unsent_comment_with_its_text_trimmed() {
        let c = comment_from_draft(draft("  rename this  "), "id1".into(), 7).unwrap();
        assert_eq!(c.body, "rename this");
        assert_eq!(c.sent_at, None);
        assert_eq!((c.created_at, c.updated_at), (7, 7));
        assert_eq!((c.new_start, c.new_end), (Some(3), Some(5)));
    }

    #[test]
    fn bad_drafts_are_refused() {
        assert!(comment_from_draft(draft("   "), "i".into(), 1).is_err());
        let mut d = draft("x");
        d.path = " ".into();
        assert!(comment_from_draft(d, "i".into(), 1).is_err());
        let mut d = draft("x");
        d.new_start = None;
        d.new_end = None;
        assert!(comment_from_draft(d, "i".into(), 1).unwrap_err().contains("at least one line"));
        let mut d = draft("x");
        d.new_start = Some(6);
        assert!(comment_from_draft(d, "i".into(), 1).is_err(), "start past end");
        let mut d = draft("x");
        d.new_end = None;
        assert!(comment_from_draft(d, "i".into(), 1).is_err(), "half a range");
        let mut d = draft("x");
        d.new_start = Some(0);
        assert!(comment_from_draft(d, "i".into(), 1).is_err(), "lines count from 1");
        let d = draft(&"y".repeat(MAX_BODY_CHARS + 1));
        assert!(comment_from_draft(d, "i".into(), 1).is_err());
        let mut d = draft("x");
        d.quoted = "q".repeat(MAX_QUOTED_CHARS + 1);
        assert!(comment_from_draft(d, "i".into(), 1).is_err());
    }

    #[test]
    fn removed_lines_only_is_a_valid_selection() {
        let mut d = draft("why was this dropped?");
        d.new_start = None;
        d.new_end = None;
        d.old_start = Some(40);
        d.old_end = Some(42);
        let c = comment_from_draft(d, "i".into(), 1).unwrap();
        assert_eq!((c.old_start, c.old_end), (Some(40), Some(42)));
        assert_eq!(c.new_start, None);
    }

    #[test]
    fn sent_comments_are_history_and_cannot_change() {
        let mut list = vec![
            comment_from_draft(draft("one"), "a".into(), 1).unwrap(),
            comment_from_draft(draft("two"), "b".into(), 1).unwrap(),
        ];
        assert_eq!(mark_sent(&mut list, &["a".into(), "gone".into()], 9), 1);
        assert_eq!(list[0].sent_at, Some(9));
        assert_eq!(list[1].sent_at, None);
        // A second mark keeps the first time.
        assert_eq!(mark_sent(&mut list, &["a".into()], 11), 0);
        assert_eq!(list[0].sent_at, Some(9));
        assert!(update(&mut list, "a", "changed", 12).unwrap_err().contains("already sent"));
        assert!(remove(&mut list, "a").is_err());
        assert_eq!(list.len(), 2);

        update(&mut list, "b", " two, better ", 13).unwrap();
        assert_eq!(list[1].body, "two, better");
        assert_eq!(list[1].updated_at, 13);
        assert!(update(&mut list, "b", "  ", 14).is_err());
        remove(&mut list, "b").unwrap();
        assert_eq!(list.len(), 1);
        assert!(remove(&mut list, "b").unwrap_err().contains("no longer"));
    }

    #[test]
    fn unsent_comments_are_capped() {
        let mut list = Vec::new();
        for i in 0..MAX_UNSENT {
            add(&mut list, comment_from_draft(draft("x"), format!("{i}"), 1).unwrap()).unwrap();
        }
        assert!(add(&mut list, comment_from_draft(draft("x"), "over".into(), 1).unwrap()).is_err());
        // Sent ones do not count.
        let ids: Vec<String> = list.iter().map(|c| c.id.clone()).collect();
        mark_sent(&mut list, &ids, 2);
        add(&mut list, comment_from_draft(draft("x"), "after".into(), 1).unwrap()).unwrap();
    }

    #[test]
    fn a_comment_written_by_an_older_or_newer_plyloft_loads() {
        // Minimal: no ranges beyond one, no quote, no updatedAt; an unknown key.
        let c: LineComment = serde_json::from_str(
            r#"{"id":"a","path":"p","newStart":1,"newEnd":1,"body":"b","createdAt":1,"laterField":true}"#,
        )
        .unwrap();
        assert_eq!(c.quoted, "");
        assert_eq!(c.updated_at, 0);
        assert_eq!(c.sent_at, None);
        let out = serde_json::to_value(&c).unwrap();
        assert!(out.get("sentAt").is_none() && out.get("oldStart").is_none(), "{out}");
    }
}
