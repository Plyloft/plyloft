//! 1.172.0 (A1): what the person asked a card's Builder **after the first
//! result** — the result's *Not right*, *Request changes* on the review's
//! lines, or *Not right — tell the Builder* from *Ask about this card*.
//!
//! Each one went only into the Builder's session, so the Challenger, which
//! reviews against the card's brief, read a change made for one as out of
//! scope. Kept on the card (`KanbanCard::later_requests`), they are shown
//! under *What you want* ("Asked later") and added to the Challenger's brief
//! (`review_context::brief_of`) and to the material Ship's pull-request
//! draft starts from (`pr_draft::prompt`). Local: never mirrored to the
//! card's issue; Ship's pull-request draft may quote them. A follow-up card
//! starts without them.
//!
//! The line comments sent to the Builder (SL-5, `line_comments.rs`) are
//! later requests too: the Challenger's block lists the sent ones with them.

use serde::{Deserialize, Serialize};

/// At most this many are kept on a card, the newest; the oldest goes first.
pub const LATER_REQUESTS_MAX: usize = 10;
/// One request's words are kept up to this many characters.
pub const LATER_REQUEST_MAX_CHARS: usize = 1500;

/// Where a later request was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaterRequestSource {
    /// The result's *Not right — tell the Builder what's wrong*.
    NotRight,
    /// *Request changes* on lines of the review.
    Changes,
    /// *Not right — tell the Builder* in *Ask about this card*.
    Chat,
    /// A source a newer app wrote: still a request, shown without a source.
    #[serde(other)]
    Other,
}

/// One request, as the person wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaterRequest {
    pub id: String,
    pub text: String,
    /// When it was sent to the Builder (ms).
    pub at: i64,
    pub source: LaterRequestSource,
}

/// The words as kept: trimmed, cut at `LATER_REQUEST_MAX_CHARS` with "…".
/// None when nothing is left.
pub fn kept_text(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= LATER_REQUEST_MAX_CHARS {
        return Some(text.to_string());
    }
    let cut: String = text.chars().take(LATER_REQUEST_MAX_CHARS).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// Add one, keeping the newest `LATER_REQUESTS_MAX`. Refused when its words
/// are empty.
pub fn add(list: &mut Vec<LaterRequest>, request: LaterRequest) -> Result<(), String> {
    let Some(text) = kept_text(&request.text) else {
        return Err("Write what you asked for first.".into());
    };
    list.push(LaterRequest { text, ..request });
    if list.len() > LATER_REQUESTS_MAX {
        let drop = list.len() - LATER_REQUESTS_MAX;
        list.drain(0..drop);
    }
    Ok(())
}

/// Remove one by id; an id no longer on the card is a no-op.
pub fn remove(list: &mut Vec<LaterRequest>, id: &str) {
    list.retain(|r| r.id != id);
}

/// The lead line of the block the Challenger reads.
pub const BRIEF_LEAD: &str = "The person also asked, after the first result:";
/// What the Challenger is told the block means.
pub const BRIEF_SCOPE: &str = "These are part of what the card asks for: a change that does what one of them says is in scope. Where one disagrees with the brief, raise it as a question, not a finding against the work.";

/// At most this many sent line comments go in the block, the newest.
pub const LINE_COMMENTS_MAX: usize = 10;

/// A sent line comment as one entry: `path:12-14: words` (the new file's
/// lines), `path (removed lines 3-4): words`, or `path: words`.
fn line_comment_entry(c: &crate::line_comments::LineComment) -> Option<String> {
    let body = kept_text(&c.body)?;
    let range = |a: u32, b: u32| if a == b { a.to_string() } else { format!("{a}-{b}") };
    let at = match (c.new_start, c.new_end, c.old_start, c.old_end) {
        (Some(a), Some(b), _, _) => format!("{}:{}", c.path, range(a, b)),
        (_, _, Some(a), Some(b)) => format!("{} (removed lines {})", c.path, range(a, b)),
        _ => c.path.clone(),
    };
    Some(format!("{at}: {body}"))
}

/// The block appended to the brief: the later requests and the line
/// comments sent to the Builder, oldest first; empty without either.
pub fn brief_block(list: &[LaterRequest], comments: &[crate::line_comments::LineComment]) -> String {
    let mut sent: Vec<(i64, String)> = comments
        .iter()
        .filter_map(|c| Some((c.sent_at?, line_comment_entry(c)?)))
        .collect();
    sent.sort_by_key(|(at, _)| *at);
    let skip = sent.len().saturating_sub(LINE_COMMENTS_MAX);
    let mut entries: Vec<(i64, String)> = list.iter().map(|r| (r.at, r.text.clone())).collect();
    entries.extend(sent.into_iter().skip(skip));
    if entries.is_empty() {
        return String::new();
    }
    entries.sort_by_key(|(at, _)| *at);
    let mut out = format!("{BRIEF_LEAD}\n");
    for (_, text) in &entries {
        out.push_str(&format!("- {}\n", bullet(text)));
    }
    out.push_str(BRIEF_SCOPE);
    out
}

/// A request's words as one bullet: later lines indented under it.
pub fn bullet(text: &str) -> String {
    text.trim().lines().collect::<Vec<_>>().join("\n  ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, text: &str) -> LaterRequest {
        LaterRequest { id: id.into(), text: text.into(), at: 1, source: LaterRequestSource::NotRight }
    }

    #[test]
    fn empty_words_are_refused_and_long_ones_cut() {
        let mut list = Vec::new();
        assert!(add(&mut list, request("a", "  \n ")).is_err());
        assert!(list.is_empty());
        add(&mut list, request("b", &"é".repeat(LATER_REQUEST_MAX_CHARS + 10))).unwrap();
        assert_eq!(list[0].text.chars().count(), LATER_REQUEST_MAX_CHARS + 1);
        assert!(list[0].text.ends_with('…'));
    }

    #[test]
    fn the_newest_are_kept_and_one_can_be_removed() {
        let mut list = Vec::new();
        for n in 0..LATER_REQUESTS_MAX + 3 {
            add(&mut list, request(&format!("r{n}"), &format!("ask {n}"))).unwrap();
        }
        assert_eq!(list.len(), LATER_REQUESTS_MAX);
        assert_eq!(list[0].id, "r3", "the oldest go first");
        remove(&mut list, "r3");
        remove(&mut list, "gone");
        assert_eq!(list.len(), LATER_REQUESTS_MAX - 1);
        assert_eq!(list[0].id, "r4");
    }

    #[test]
    fn the_brief_block_lists_them_oldest_first() {
        assert_eq!(brief_block(&[], &[]), "");
        let block = brief_block(&[request("a", "also add a comment"), request("b", "line one\nline two")], &[]);
        assert!(block.starts_with(BRIEF_LEAD), "{block}");
        assert!(block.contains("- also add a comment\n- line one\n  line two\n"), "{block}");
        assert!(block.ends_with(BRIEF_SCOPE));
    }

    #[test]
    fn a_source_from_a_newer_app_reads_as_other() {
        let r: LaterRequest =
            serde_json::from_str(r#"{"id":"x","text":"t","at":2,"source":"somethingNew"}"#).unwrap();
        assert_eq!(r.source, LaterRequestSource::Other);
        let back = serde_json::to_value(request("a", "t")).unwrap();
        assert_eq!(back["source"], "notRight");
    }

    fn comment(path: &str, new: Option<(u32, u32)>, old: Option<(u32, u32)>, body: &str, sent_at: Option<i64>) -> crate::line_comments::LineComment {
        crate::line_comments::LineComment {
            id: format!("lc-{body}"),
            path: path.into(),
            new_start: new.map(|r| r.0),
            new_end: new.map(|r| r.1),
            old_start: old.map(|r| r.0),
            old_end: old.map(|r| r.1),
            quoted: String::new(),
            body: body.into(),
            created_at: 0,
            updated_at: 0,
            sent_at,
        }
    }

    #[test]
    fn sent_line_comments_join_the_block_in_time_order_and_unsent_ones_stay_out() {
        let mut first = request("a", "also add a comment");
        first.at = 20;
        let comments = [
            comment("src/a.ts", Some((12, 14)), None, "name it after what it holds", Some(10)),
            comment("src/b.ts", None, Some((3, 3)), "keep this line", Some(30)),
            comment("src/c.ts", Some((1, 1)), None, "not sent yet", None),
        ];
        let block = brief_block(&[first], &comments);
        assert!(
            block.contains("- src/a.ts:12-14: name it after what it holds\n- also add a comment\n- src/b.ts (removed lines 3): keep this line\n"),
            "{block}"
        );
        assert!(!block.contains("not sent yet"));
        assert_eq!(brief_block(&[], &comments[2..]), "");
        let many: Vec<_> = (0..LINE_COMMENTS_MAX as i64 + 2)
            .map(|n| comment("x.ts", Some((1, 1)), None, &format!("c{n}"), Some(n)))
            .collect();
        let block = brief_block(&[], &many);
        assert!(!block.contains(": c0\n") && !block.contains(": c1\n") && block.contains(": c2\n"), "{block}");
    }
}
