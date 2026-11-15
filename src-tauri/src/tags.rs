//! Independent tag presence registers preserve concurrent edits to other tags.
use automerge::{transaction::Transactable, AutoCommit, ObjId, ReadDoc};
use serde::Deserialize;

const PREFIX: &str = "_tag:";
pub(crate) const MAX_TAGS_PER_ITEM: usize = 32;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TagKind {
    Note,
    File,
}

pub(crate) fn normalize(value: &str) -> Result<String> {
    if value.chars().any(char::is_control) {
        return Err("Tags cannot contain control characters.".into());
    }
    let tag = value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if tag.is_empty() || tag.chars().count() > 32 {
        return Err("Choose a tag between 1 and 32 characters.".into());
    }
    Ok(tag)
}

pub(crate) fn read(doc: &AutoCommit, object: &ObjId) -> Result<Vec<String>> {
    let mut tags = Vec::new();
    for key in doc.keys(object).filter(|key| key.starts_with(PREFIX)) {
        let tag = key.strip_prefix(PREFIX).ok_or("Invalid tag metadata.")?;
        if normalize(tag)? != tag {
            return Err("The peer document contains a noncanonical tag.".into());
        }
        let values = doc.get_all(object, &key).map_err(message)?;
        if values.is_empty() || values.iter().any(|(value, _)| value.as_bool().is_none()) {
            return Err("The peer document contains invalid tag metadata.".into());
        }
        // A concurrent addition survives a removal it has not observed. A later
        // removal writes over every observed value, including such conflicts.
        if values
            .iter()
            .any(|(value, _)| value.as_bool() == Some(true))
        {
            tags.push(tag.to_owned());
        }
    }
    tags.sort();
    Ok(tags)
}

pub(crate) fn set(
    doc: &mut AutoCommit,
    object: &ObjId,
    value: &str,
    present: bool,
) -> Result<bool> {
    let tag = normalize(value)?;
    let current = read(doc, object)?;
    if current.contains(&tag) == present {
        return Ok(false);
    }
    if present && current.len() >= MAX_TAGS_PER_ITEM {
        return Err("An item can have up to 32 tags. Remove a tag before adding another.".into());
    }
    // Do not impose this local edit limit when reading merged documents: two
    // peers may independently add the 32nd tag. All history remains bounded by
    // the document's existing 8 MiB limit, and removals are always available.
    doc.put(object, format!("{PREFIX}{tag}"), present)
        .map_err(message)?;
    Ok(true)
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::{ObjType, ROOT};

    #[test]
    fn tag_names_normalize_unicode_and_reject_invalid_metadata() {
        assert_eq!(normalize("  Field\u{2003} NOTES  ").unwrap(), "field notes");
        assert_eq!(normalize("ÆØÅ").unwrap(), "æøå");
        for value in ["", "   ", "line\nbreak", "tab\tlabel", "\u{85}", "\0"] {
            assert!(normalize(value).is_err());
        }
        assert!(normalize(&"📝".repeat(32)).is_ok());
        assert!(normalize(&"📝".repeat(33)).is_err());
        let mut doc = AutoCommit::new();
        let object = doc.put_object(ROOT, "note", ObjType::Map).unwrap();
        assert!(read(&doc, &object).unwrap().is_empty());
        doc.put(&object, "_tag:Work", true).unwrap();
        assert!(read(&doc, &object).is_err());
        doc.delete(&object, "_tag:Work").unwrap();
        doc.put(&object, "_tag:work", "yes").unwrap();
        assert!(read(&doc, &object).is_err());
    }

    #[test]
    fn concurrent_presence_registers_merge_and_observed_removal_clears_conflicts() {
        let mut original = AutoCommit::new();
        let object = original.put_object(ROOT, "note", ObjType::Map).unwrap();
        set(&mut original, &object, "work", true).unwrap();
        let mut a = original.fork();
        let mut b = original.fork();
        set(&mut a, &object, "work", false).unwrap();
        set(&mut b, &object, "work", false).unwrap();
        set(&mut b, &object, "work", true).unwrap();
        a.merge(&mut b).unwrap();
        assert_eq!(read(&a, &object).unwrap(), ["work"]);
        set(&mut a, &object, "work", false).unwrap();
        assert!(read(&a, &object).unwrap().is_empty());
    }
}
