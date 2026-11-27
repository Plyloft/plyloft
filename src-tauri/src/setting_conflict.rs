//! 1.173.0 (C3): a shared setting both computers changed — what the question
//! shows, and its Inbox row.
//!
//! The write channel (`shared_config::prepare`) no longer lets the last
//! writer win silently: when the branch's value of a field changed after this
//! Mac read it (another member, or the same person on another computer), that
//! field is held in the queue with a [`FieldConflict`] and every other field
//! publishes as before. The person answers *Keep theirs* (this Mac's edit is
//! dropped and the repository's value applies) or *Use this Mac's* (it is
//! published over exactly that value, the override named in the commit as
//! before) — `workspace_definition::resolve_conflict`.
//!
//! This module only reads: the question's words come from the queue entry,
//! and the difference shows what differs, never the two whole values.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared_config::{describe, describe_item, FieldConflict, PublishQueue};
use crate::workspace_definition::field_label;

/// What differs between the branch's value and this Mac's.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    /// Both values are lists: the four lists below say it; otherwise
    /// `theirs` and `mine` do.
    pub list: bool,
    /// Items both have, the same.
    pub both: Vec<String>,
    /// Items only this Mac's value has.
    pub only_mine: Vec<String>,
    /// Items only the branch's value has.
    pub only_theirs: Vec<String>,
    /// Items both have, set differently (an area whose folder or branch
    /// changed on either side).
    pub different: Vec<String>,
    /// A single value, in words.
    pub theirs: String,
    pub mine: String,
    /// C3 Challenger 4: a value made of keys (the suggested models): only
    /// the keys the two sides set differently, in words.
    #[serde(default)]
    pub keys: Vec<KeyDifference>,
}

/// One key both sides set differently: "Claude · Build", "Opus", "Sonnet".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct KeyDifference {
    pub name: String,
    pub theirs: String,
    pub mine: String,
}

/// One open question, for the sheet and the Inbox.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingConflict {
    pub field: String,
    pub label: String,
    pub author: Option<String>,
    pub device: Option<String>,
    pub same_person: bool,
    /// Seconds.
    pub changed_at: Option<i64>,
    /// C3 Challenger 2: it came from another folder of this repository on
    /// this very computer.
    #[serde(default)]
    pub this_computer: bool,
    /// C3 Challenger 1: the branch's value as the question shows it — sent
    /// back with the answer, so an answer to an older question records
    /// nothing.
    #[serde(default)]
    pub theirs: Value,
    pub difference: Difference,
}

/// What identifies an item across the two lists: an area by its id, a
/// version file or step by its words.
fn item_key(item: &Value) -> String {
    match item.get("id").and_then(Value::as_str) {
        Some(id) if item.get("name").is_some() => format!("id:{id}"),
        _ => describe_item(item),
    }
}

/// A key in words: `claude` → "Claude", `build` → "Build".
fn key_words(key: &str) -> String {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// A value in the app's words: on/off, the board by its place, a list by
/// its items.
fn words(field: &str, value: &Value) -> String {
    match (field, value) {
        (_, Value::Bool(true)) => "On".to_string(),
        (_, Value::Bool(false)) => "Off".to_string(),
        ("board", Value::String(id)) if id == "githubIssues" => "GitHub Issues".to_string(),
        ("board", Value::String(id)) if id == "local" => format!("On {}", crate::platform::THIS_MACHINE),
        // Absent from a set of keys: nothing set there.
        (_, Value::Null) => "none".to_string(),
        (_, Value::Object(_)) => {
            let mut leaves = Vec::new();
            flatten("", value, &mut leaves);
            if leaves.is_empty() {
                "none".to_string()
            } else {
                leaves.iter().map(|(k, v)| format!("{k}: {}", words("", v))).collect::<Vec<_>>().join(" · ")
            }
        }
        _ => describe(value),
    }
}

/// Every leaf of a value made of keys, as ("Claude · Build", value).
fn flatten(prefix: &str, value: &Value, out: &mut Vec<(String, Value)>) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                let name = if prefix.is_empty() { key_words(key) } else { format!("{prefix} · {}", key_words(key)) };
                flatten(&name, inner, out);
            }
        }
        other => out.push((prefix.to_string(), other.clone())),
    }
}

/// The difference between `theirs` and `mine` for `field`. Lists (areas
/// included, a whole-list field) compare item by item; values made of keys
/// key by key, naming only the keys set differently; anything else is the
/// two values in words.
pub fn difference(field: &str, theirs: &Value, mine: &Value) -> Difference {
    let single = || Difference { theirs: words(field, theirs), mine: words(field, mine), ..Default::default() };
    if theirs.is_object() || mine.is_object() {
        let (mut t, mut m) = (Vec::new(), Vec::new());
        if theirs.is_object() {
            flatten("", theirs, &mut t);
        }
        if mine.is_object() {
            flatten("", mine, &mut m);
        }
        let mut names: Vec<String> = t.iter().chain(m.iter()).map(|(k, _)| k.clone()).collect();
        names.sort();
        names.dedup();
        let get = |list: &[(String, Value)], name: &str| {
            list.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()).unwrap_or(Value::Null)
        };
        let keys: Vec<KeyDifference> = names
            .into_iter()
            .filter_map(|name| {
                let (a, b) = (get(&t, &name), get(&m, &name));
                (a != b).then(|| KeyDifference { theirs: words(field, &a), mine: words(field, &b), name })
            })
            .collect();
        let join = |pick: fn(&KeyDifference) -> &String| {
            keys.iter().map(|k| format!("{}: {}", k.name, pick(k))).collect::<Vec<_>>().join(" · ")
        };
        return Difference { theirs: join(|k| &k.theirs), mine: join(|k| &k.mine), keys, ..Default::default() };
    }
    let as_list = |v: &Value| match v {
        Value::Array(items) => Some(items.clone()),
        Value::Null => Some(Vec::new()),
        _ => None,
    };
    let (Some(t), Some(m)) = (as_list(theirs), as_list(mine)) else {
        return single();
    };
    if theirs.is_null() && mine.is_null() {
        return single();
    }
    let mut out = Difference { list: true, theirs: describe(theirs), mine: describe(mine), ..Default::default() };
    for item in &m {
        let key = item_key(item);
        match t.iter().find(|other| item_key(other) == key) {
            Some(other) if other == item => out.both.push(describe_item(item)),
            Some(_) => out.different.push(describe_item(item)),
            None => out.only_mine.push(describe_item(item)),
        }
    }
    for item in &t {
        let key = item_key(item);
        if !m.iter().any(|other| item_key(other) == key) {
            out.only_theirs.push(describe_item(item));
        }
    }
    out
}

fn view(field: &str, mine: &Value, conflict: &FieldConflict) -> SettingConflict {
    // C3 Challenger 4: a field merged key by key shows what *Use this Mac's*
    // would publish.
    let mine = conflict.merged.as_ref().map(|m| &m.over).unwrap_or(mine);
    SettingConflict {
        this_computer: conflict.this_computer,
        theirs: conflict.theirs.clone(),
        field: field.to_string(),
        label: field_label(field).to_string(),
        author: conflict.author.clone(),
        device: conflict.device.clone(),
        same_person: conflict.same_person,
        changed_at: conflict.changed_at,
        difference: difference(field, &conflict.theirs, mine),
    }
}

/// Every open question in a workspace's queue, in field order.
pub fn conflicts_of(queue: &PublishQueue) -> Vec<SettingConflict> {
    queue
        .fields
        .iter()
        .filter_map(|(key, field)| field.conflict.as_ref().map(|c| view(key, &field.value, c)))
        .collect()
}

/// "both Macs" / "both PCs".
use crate::platform::BOTH_MACHINES;

/// The Inbox row's title: "A setting both Macs changed: Version files", or
/// "A setting bob changed too: Version files" for a teammate.
pub fn inbox_title(conflict: &SettingConflict) -> String {
    // A teammate's own computer is theirs to name; only the same person's
    // computers are "both Macs".
    if conflict.this_computer {
        return format!("A setting two folders on {} changed: {}", crate::platform::THIS_MACHINE, conflict.label);
    }
    match (&conflict.author, conflict.same_person) {
        (Some(author), false) => format!("A setting {author} changed too: {}", conflict.label),
        _ => format!("A setting {BOTH_MACHINES} changed: {}", conflict.label),
    }
}

/// The Inbox row's id: stable while the question stands, new when the other
/// side changes the value again.
pub fn inbox_id(workspace_id: &str, conflict: &SettingConflict) -> String {
    format!("setting-conflict:{workspace_id}:{}:{}", conflict.field, conflict.changed_at.unwrap_or_default())
}

/// The field an Inbox row's id is about.
#[cfg_attr(not(test), allow(dead_code))]
pub fn field_of_inbox_id(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("setting-conflict:")?;
    let mut parts = rest.rsplitn(2, ':');
    parts.next()?;
    parts.next()?.rsplit(':').next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_list_shows_only_what_differs() {
        let theirs = json!([{ "path": "frontend/package.json" }, { "path": "main.py" }]);
        let mine = json!([{ "path": "frontend/package.json" }, { "path": "main.py" }, { "path": "shopify/package.json" }]);
        let d = difference("versionFiles", &theirs, &mine);
        assert!(d.list);
        assert_eq!(d.both, vec!["frontend/package.json", "main.py"]);
        assert_eq!(d.only_mine, vec!["shopify/package.json"]);
        assert!(d.only_theirs.is_empty() && d.different.is_empty());

        let d = difference("versionFiles", &mine, &theirs);
        assert_eq!(d.only_theirs, vec!["shopify/package.json"]);
        assert!(d.only_mine.is_empty());
    }

    #[test]
    fn areas_are_named_added_removed_or_changed() {
        let theirs = json!([
            { "id": "app", "name": "App", "path": "" },
            { "id": "site", "name": "Site", "path": "site" },
            { "id": "docs", "name": "Docs", "path": "docs" }
        ]);
        let mine = json!([
            { "id": "app", "name": "App", "path": "" },
            { "id": "site", "name": "Site", "path": "web" },
            { "id": "shop", "name": "Shop", "path": "shopify" }
        ]);
        let d = difference("areas", &theirs, &mine);
        assert_eq!(d.both, vec!["App"]);
        assert_eq!(d.different, vec!["Site"]);
        assert_eq!(d.only_mine, vec!["Shop"]);
        assert_eq!(d.only_theirs, vec!["Docs"]);
    }

    #[test]
    fn a_single_value_is_theirs_against_mine() {
        let d = difference("installScript", &json!("scripts/theirs.sh"), &json!("scripts/mine.sh"));
        assert!(!d.list);
        assert_eq!((d.theirs.as_str(), d.mine.as_str()), ("scripts/theirs.sh", "scripts/mine.sh"));
        let d = difference("selfCheck", &Value::Null, &json!(true));
        assert!(!d.list);
        assert_eq!(d.theirs, "none");
    }

    #[test]
    fn the_inbox_row_names_both_computers_or_the_member() {
        let mut c = SettingConflict {
            field: "versionFiles".into(),
            label: "Version files".into(),
            author: Some("matteo".into()),
            device: Some("MacBook Pro".into()),
            same_person: true,
            changed_at: Some(1000),
            this_computer: false,
            theirs: Value::Null,
            difference: Difference::default(),
        };
        assert_eq!(inbox_title(&c), format!("A setting {BOTH_MACHINES} changed: Version files"));
        c.same_person = false;
        c.author = Some("bob".into());
        assert_eq!(inbox_title(&c), "A setting bob changed too: Version files");
        let id = inbox_id("ws-1", &c);
        assert_eq!(id, "setting-conflict:ws-1:versionFiles:1000");
        assert_eq!(field_of_inbox_id(&id), Some("versionFiles"));
    }


    #[test]
    fn c3r1_values_of_keys_name_only_the_keys_set_differently() {
        let theirs = json!({ "claude": { "build": "opus", "review": "sonnet" }, "codex": { "build": "gpt-5" } });
        let mine = json!({ "claude": { "build": "sonnet", "review": "sonnet" }, "codex": { "build": "gpt-5" } });
        let d = difference("models", &theirs, &mine);
        assert!(!d.list);
        assert_eq!(
            d.keys,
            vec![KeyDifference { name: "Claude · Build".into(), theirs: "opus".into(), mine: "sonnet".into() }]
        );
        assert_eq!(d.theirs, "Claude · Build: opus");
        assert!(!d.mine.contains('{'), "never raw JSON: {}", d.mine);
        // A key only one side sets reads as "none" on the other.
        let d = difference("models", &json!({ "claude": { "build": "opus" } }), &Value::Null);
        assert_eq!(d.keys[0].mine, "none");
    }

    #[test]
    fn c3r1_booleans_and_boards_in_words() {
        let d = difference("sharedBuildCache", &json!(true), &json!(false));
        assert_eq!((d.theirs.as_str(), d.mine.as_str()), ("On", "Off"));
        let d = difference("board", &json!("githubIssues"), &json!("local"));
        assert_eq!(d.theirs, "GitHub Issues");
        assert_eq!(d.mine, format!("On {}", crate::platform::THIS_MACHINE));
    }

    #[test]
    fn c3r1_a_checklist_class_is_named_by_its_name() {
        let class = json!({ "name": "Money", "sentence": "Prices stay in cents" });
        assert_eq!(describe_item(&class), "Money");
        assert_eq!(describe_item(&json!({ "name": "review" })), "/review");
    }

    #[test]
    fn c3r1_another_folder_on_this_computer_is_said_so() {
        let c = SettingConflict {
            field: "name".into(),
            label: "Name".into(),
            author: Some("matteo".into()),
            device: Some("Mac mini".into()),
            same_person: true,
            changed_at: Some(1),
            this_computer: true,
            theirs: Value::Null,
            difference: Difference::default(),
        };
        assert_eq!(inbox_title(&c), format!("A setting two folders on {} changed: Name", crate::platform::THIS_MACHINE));
    }
}
