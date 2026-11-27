//! 1.175.0 (C6, review SC-9): what a publish writes back of
//! `.atelier/workspace.json` that this build's types don't know.
//!
//! Every publish passes the whole file through the Rust types
//! (`workspace_definition::file_text`). The definition itself keeps unknown
//! top-level keys (`extra`), but a key a later Plyloft adds *inside* a value
//! — one entry of `versionFiles`, one check of `verifyPipeline`, one class
//! of `reviewChecklist`, `library.plySkills` — has no such place: a rewrite
//! from an older build dropped it from every entry.
//!
//! [`keeping`] takes three texts — what the types write now (`new`), what
//! they write for the file as it is on the branch (`known`), and that file
//! (`written`) — and gives the text to commit:
//!
//! - a value this publish doesn't change is written back **as it was on the
//!   branch**, with every key it had;
//! - in a list this publish changes, each item the types write the same as
//!   before is the branch's item, as it was; an item this computer edited or
//!   added is the types' own (what an unknown key meant for the old value
//!   isn't known for the new one);
//! - in an object this publish changes, the keys the types don't write stay,
//!   after the ones they do.
//!
//! Key order: the types' own for whatever they write, the file's for what is
//! kept as it was. A file Plyloft wrote and nobody changes comes back byte
//! for byte.
//!
//! The types never read anything different because of it: when the kept
//! text doesn't read as exactly what `new` reads as, `new` is the answer
//! ([`workspace_definition::file_text`] checks).

use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// A JSON value whose objects keep the order of their keys (`serde_json`'s
/// own map sorts them here: the crate builds without `preserve_order`).
#[derive(Debug, Clone, PartialEq)]
enum Node {
    Leaf(Value),
    List(Vec<Node>),
    Object(Vec<(String, Node)>),
}

impl Node {
    /// The same value with nothing said about key order, for comparisons.
    fn value(&self) -> Value {
        match self {
            Node::Leaf(value) => value.clone(),
            Node::List(items) => Value::Array(items.iter().map(Node::value).collect()),
            Node::Object(entries) => {
                Value::Object(entries.iter().map(|(key, node)| (key.clone(), node.value())).collect())
            }
        }
    }
}

fn entry<'a>(entries: &'a [(String, Node)], key: &str) -> Option<&'a Node> {
    entries.iter().rev().find(|(k, _)| k == key).map(|(_, node)| node)
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct NodeVisitor;
        impl<'de> Visitor<'de> for NodeVisitor {
            type Value = Node;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_bool<E>(self, v: bool) -> Result<Node, E> {
                Ok(Node::Leaf(Value::Bool(v)))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Node, E> {
                Ok(Node::Leaf(Value::Number(v.into())))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Node, E> {
                Ok(Node::Leaf(Value::Number(v.into())))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Node, E> {
                Ok(Node::Leaf(serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number)))
            }
            fn visit_str<E>(self, v: &str) -> Result<Node, E> {
                Ok(Node::Leaf(Value::String(v.to_string())))
            }
            fn visit_string<E>(self, v: String) -> Result<Node, E> {
                Ok(Node::Leaf(Value::String(v)))
            }
            fn visit_unit<E>(self) -> Result<Node, E> {
                Ok(Node::Leaf(Value::Null))
            }
            fn visit_none<E>(self) -> Result<Node, E> {
                Ok(Node::Leaf(Value::Null))
            }
            fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Node, D::Error> {
                Node::deserialize(deserializer)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<Node>()? {
                    items.push(item);
                }
                Ok(Node::List(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
                // A key written twice: the last value, where the first stood
                // — one key in the text written back, as JSON readers take it.
                let mut entries: Vec<(String, Node)> = Vec::new();
                while let Some((key, node)) = map.next_entry::<String, Node>()? {
                    match entries.iter_mut().find(|(k, _)| *k == key) {
                        Some(slot) => slot.1 = node,
                        None => entries.push((key, node)),
                    }
                }
                Ok(Node::Object(entries))
            }
        }
        deserializer.deserialize_any(NodeVisitor)
    }
}

impl Serialize for Node {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Node::Leaf(value) => value.serialize(serializer),
            Node::List(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Node::Object(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, node) in entries {
                    map.serialize_entry(key, node)?;
                }
                map.end()
            }
        }
    }
}

/// `new` with what `written` holds beyond `known` (see the module's words).
fn keep(new: &Node, known: Option<&Node>, written: Option<&Node>) -> Node {
    let (Some(known), Some(written)) = (known, written) else {
        return new.clone();
    };
    if new.value() == known.value() {
        return written.clone();
    }
    match (new, known, written) {
        (Node::Object(new), Node::Object(known), Node::Object(written)) => {
            let mut out: Vec<(String, Node)> = new
                .iter()
                .map(|(key, node)| (key.clone(), keep(node, entry(known, key), entry(written, key))))
                .collect();
            for (key, node) in written {
                if entry(known, key).is_none() && entry(&out, key).is_none() {
                    out.push((key.clone(), node.clone()));
                }
            }
            Node::Object(out)
        }
        (Node::List(new), Node::List(known), Node::List(written)) if known.len() == written.len() => {
            let known: Vec<Value> = known.iter().map(Node::value).collect();
            let mut taken = vec![false; known.len()];
            Node::List(
                new.iter()
                    .enumerate()
                    .map(|(position, item)| {
                        let value = item.value();
                        let fits = |i: usize| i < known.len() && !taken[i] && known[i] == value;
                        // Round 2: several items may be equal in everything
                        // the types know. The one at the same position is
                        // the same item unless the list says otherwise; only
                        // then the first that fits.
                        let fit = if fits(position) { Some(position) } else { (0..known.len()).find(|&i| fits(i)) };
                        match fit {
                            Some(i) => {
                                taken[i] = true;
                                written[i].clone()
                            }
                            None => item.clone(),
                        }
                    })
                    .collect(),
            )
        }
        _ => new.clone(),
    }
}

/// The text to commit: `new` (what the types write now), keeping what
/// `written` (the file on the branch) holds that `known` (what the types
/// write for that file) doesn't. `None` when one of the three isn't JSON —
/// the caller writes `new`.
pub(crate) fn keeping(new: &str, known: &str, written: &[u8]) -> Option<String> {
    let new: Node = serde_json::from_str(new).ok()?;
    let known: Node = serde_json::from_str(known).ok()?;
    let written: Node = serde_json::from_slice(written).ok()?;
    let mut text = serde_json::to_string_pretty(&keep(&new, Some(&known), Some(&written))).ok()?;
    text.push('\n');
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_nothing_changes_comes_back_as_it_was_key_order_included() {
        let written = "{\n  \"zeta\": 1,\n  \"alpha\": {\n    \"b\": [\n      1,\n      2\n    ],\n    \"a\": null\n  }\n}\n";
        // The types sort and drop: `known` and `new` say the same.
        let known = "{\"alpha\":{\"b\":[1,2]},\"zeta\":1}";
        assert_eq!(keeping(known, known, written.as_bytes()).as_deref(), Some(written));
    }

    #[test]
    fn a_changed_value_is_the_new_one_and_the_rest_is_as_it_was() {
        let written = r#"{"name":"A","list":[{"id":1,"later":true},{"id":2}],"color":"red"}"#;
        let known = r#"{"name":"A","color":"red","list":[{"id":1},{"id":2}]}"#;
        let new = r#"{"name":"A","color":"blue","list":[{"id":1},{"id":2}]}"#;
        let text = keeping(new, known, written.as_bytes()).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["color"], "blue");
        assert_eq!(value["list"][0]["later"], true, "{text}");
        // The types' order for what they write.
        assert!(text.find("\"name\"").unwrap() < text.find("\"color\"").unwrap());
        assert!(text.find("\"color\"").unwrap() < text.find("\"list\"").unwrap());
    }

    #[test]
    fn in_a_changed_list_an_untouched_item_is_the_branchs_and_an_edited_one_the_types() {
        let written = r#"{"list":[{"id":1,"later":"one"},{"id":2,"later":"two"},{"id":3,"later":"three"}]}"#;
        let known = r#"{"list":[{"id":1},{"id":2},{"id":3}]}"#;
        // 2 removed, 3 moved up, 1 edited into 9, 4 added.
        let new = r#"{"list":[{"id":3},{"id":9},{"id":4}]}"#;
        let text = keeping(new, known, written.as_bytes()).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"list":[{"id":3,"later":"three"},{"id":9},{"id":4}]})
        );
    }

    #[test]
    fn two_equal_items_take_the_branchs_two_in_order() {
        let written = r#"{"list":[{"id":1,"later":"first"},{"id":1,"later":"second"},{"id":2}]}"#;
        let known = r#"{"list":[{"id":1},{"id":1},{"id":2}]}"#;
        let new = r#"{"list":[{"id":1},{"id":1},{"id":1}]}"#;
        let value: Value = serde_json::from_str(&keeping(new, known, written.as_bytes()).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"list":[{"id":1,"later":"first"},{"id":1,"later":"second"},{"id":1}]})
        );
    }

    #[test]
    fn an_item_that_stays_where_it_was_keeps_its_own_keys_when_an_equal_one_is_elsewhere() {
        // Two items equal in every known field; the second is deleted.
        let written = r#"{"list":[{"id":1,"later":"first"},{"id":2},{"id":1,"later":"second"}]}"#;
        let known = r#"{"list":[{"id":1},{"id":2},{"id":1}]}"#;
        let value: Value =
            serde_json::from_str(&keeping(r#"{"list":[{"id":1},{"id":2}]}"#, known, written.as_bytes()).unwrap()).unwrap();
        assert_eq!(value, serde_json::json!({"list":[{"id":1,"later":"first"},{"id":2}]}));
        // The middle one changes: each equal item keeps its own, by position.
        let value: Value =
            serde_json::from_str(&keeping(r#"{"list":[{"id":1},{"id":9},{"id":1}]}"#, known, written.as_bytes()).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"list":[{"id":1,"later":"first"},{"id":9},{"id":1,"later":"second"}]})
        );
        // The first one is replaced: the last, still last, keeps its own
        // (the first fit would have handed it the first one's).
        let value: Value =
            serde_json::from_str(&keeping(r#"{"list":[{"id":7},{"id":2},{"id":1}]}"#, known, written.as_bytes()).unwrap()).unwrap();
        assert_eq!(value, serde_json::json!({"list":[{"id":7},{"id":2},{"id":1,"later":"second"}]}));
        // Moved to another position: the first that fits, as before.
        let value: Value =
            serde_json::from_str(&keeping(r#"{"list":[{"id":2},{"id":1}]}"#, known, written.as_bytes()).unwrap()).unwrap();
        assert_eq!(value, serde_json::json!({"list":[{"id":2},{"id":1,"later":"first"}]}));
    }

    #[test]
    fn in_a_changed_object_the_keys_the_types_dont_write_stay_after_theirs() {
        let written = r#"{"box":{"later":7,"off":["a"],"on":[]}}"#;
        let known = r#"{"box":{"off":["a"],"on":[]}}"#;
        let new = r#"{"box":{"off":["a","b"],"on":[]}}"#;
        let text = keeping(new, known, written.as_bytes()).unwrap();
        assert_eq!(
            text,
            "{\n  \"box\": {\n    \"off\": [\n      \"a\",\n      \"b\"\n    ],\n    \"on\": [],\n    \"later\": 7\n  }\n}\n"
        );
    }

    #[test]
    fn a_key_this_publish_removes_is_gone_and_one_it_sets_wins() {
        // `color` is known and removed; `try` held a value the types read
        // as unset, and this publish sets it.
        let written = r#"{"name":"A","color":"red","try":5}"#;
        let known = r#"{"name":"A","color":"red"}"#;
        let new = r#"{"name":"A","try":"npm run dev"}"#;
        let value: Value = serde_json::from_str(&keeping(new, known, written.as_bytes()).unwrap()).unwrap();
        assert_eq!(value, serde_json::json!({"name":"A","try":"npm run dev"}));
    }

    #[test]
    fn a_value_the_types_read_as_unset_stays_as_it_was() {
        let written = r#"{"name":"A","try":5}"#;
        let known = r#"{"name":"A"}"#;
        let new = r#"{"name":"B"}"#;
        let value: Value = serde_json::from_str(&keeping(new, known, written.as_bytes()).unwrap()).unwrap();
        assert_eq!(value, serde_json::json!({"name":"B","try":5}));
    }

    #[test]
    fn a_key_written_twice_is_written_once_with_its_last_value() {
        let written = r#"{"name":"A","name":"B","other":1}"#;
        let known = r#"{"name":"B","other":1}"#;
        let text = keeping(known, known, written.as_bytes()).unwrap();
        assert_eq!(text, "{\n  \"name\": \"B\",\n  \"other\": 1\n}\n");
    }

    #[test]
    fn a_text_that_isnt_json_gives_no_answer() {
        assert_eq!(keeping("{}", "{}", b"{ not json"), None);
        assert_eq!(keeping("{", "{}", b"{}"), None);
    }

    #[test]
    fn numbers_strings_and_nulls_come_back_as_written() {
        let written = "{\n  \"a\": 1.5,\n  \"b\": -3,\n  \"c\": \"x\\ny\",\n  \"d\": null,\n  \"e\": 18446744073709551615,\n  \"f\": true\n}\n";
        let known = written;
        assert_eq!(keeping(known, known, written.as_bytes()).as_deref(), Some(written));
    }
}
