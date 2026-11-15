//! File metadata is a CRDT; immutable bytes live separately in SQLite.
use automerge::{transaction::Transactable, AutoCommit, ObjId, ObjType, ReadDoc, Value, ROOT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;

pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_NETWORK_FILE_BYTES: u64 = 250 * 1024 * 1024;
const MAX_FILES: usize = 500;
const PREFIX: &str = "_file:";
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub sha256: String,
    pub created_at: u64,
    pub available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub name: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MissingFile {
    pub id: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone)]
pub(crate) struct FileRecord {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub sha256: String,
    pub created_at: u64,
    pub deleted: bool,
}

impl FileRecord {
    pub fn request(&self) -> MissingFile {
        MissingFile {
            id: self.id.clone(),
            sha256: self.sha256.clone(),
            size: self.size,
        }
    }

    pub fn view(&self, available: bool) -> SharedFile {
        SharedFile {
            id: self.id.clone(),
            name: self.name.clone(),
            mime_type: self.mime_type.clone(),
            size: self.size,
            sha256: self.sha256.clone(),
            created_at: self.created_at,
            available,
        }
    }
}

pub(crate) fn content_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn validate_content(request: &MissingFile, bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_FILE_BYTES
        || u64::try_from(bytes.len()).map_err(message)? != request.size
        || content_hash(bytes) != request.sha256
    {
        return Err(
            "The file content does not match its authenticated size and SHA-256 hash.".into(),
        );
    }
    Ok(())
}

pub(crate) fn validate_name_mime(name: &str, mime: &str) -> Result<()> {
    if name.trim().is_empty()
        || matches!(name, "." | "..")
        || name.len() > 1024
        || name.chars().count() > 255
        || name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err("Choose a file name of 1–255 characters without path separators.".into());
    }
    let valid_token = |token: &str| {
        !token.is_empty()
            && token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
    };
    if mime.len() > 127
        || !mime
            .split_once('/')
            .is_some_and(|(kind, subtype)| valid_token(kind) && valid_token(subtype))
    {
        return Err("The file's media type is invalid.".into());
    }
    Ok(())
}

pub(crate) fn add_file(doc: &mut AutoCommit, file: &FileRecord) -> Result<()> {
    let object = doc
        .put_object(ROOT, format!("{PREFIX}{}", file.id), ObjType::Map)
        .map_err(message)?;
    doc.put(&object, "name", file.name.as_str())
        .map_err(message)?;
    doc.put(&object, "mimeType", file.mime_type.as_str())
        .map_err(message)?;
    doc.put(&object, "size", file.size).map_err(message)?;
    doc.put(&object, "sha256", file.sha256.as_str())
        .map_err(message)?;
    doc.put(&object, "createdAt", file.created_at)
        .map_err(message)?;
    doc.put(&object, "deleted", false).map_err(message)?;
    Ok(())
}

pub(crate) fn delete_file(doc: &mut AutoCommit, id: &str) -> Result<()> {
    let object = file_object(doc, id)?;
    doc.put(&object, "deleted", true).map_err(message)?;
    Ok(())
}

pub(crate) fn read_files(doc: &AutoCommit) -> Result<Vec<FileRecord>> {
    let mut records = Vec::new();
    let mut sizes = HashMap::new();
    let mut total = 0u64;
    for key in doc.keys(ROOT).filter(|key| key.starts_with(PREFIX)) {
        if records.len() >= MAX_FILES {
            return Err("This network has reached its 500-file history limit.".into());
        }
        let id = key.strip_prefix(PREFIX).ok_or("Invalid file record.")?;
        let object = file_object(doc, id)?;
        let name = text(doc, &object, "name")?;
        let mime_type = text(doc, &object, "mimeType")?;
        validate_name_mime(&name, &mime_type)?;
        let size = number(doc, &object, "size")?;
        if size > u64::try_from(MAX_FILE_BYTES).map_err(message)? {
            return Err("A shared file exceeds the 25 MiB limit.".into());
        }
        let sha256 = text(doc, &object, "sha256")?;
        if sha256.len() != 64
            || !sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Invalid file SHA-256 hash.".into());
        }
        let flags = doc.get_all(&object, "deleted").map_err(message)?;
        if flags.is_empty() || flags.iter().any(|(value, _)| value.as_bool().is_none()) {
            return Err("Invalid file deletion state.".into());
        }
        let deleted = flags.iter().any(|(value, _)| value.as_bool() == Some(true));
        if !deleted {
            match sizes.insert(sha256.clone(), size) {
                Some(previous) if previous != size => {
                    return Err("Conflicting file sizes for one content hash.".into())
                }
                Some(_) => {}
                None => {
                    total = total
                        .checked_add(size)
                        .ok_or("Shared files exceed the size limit.")?;
                }
            }
            if total > MAX_NETWORK_FILE_BYTES {
                return Err("This network has reached its 250 MiB shared-file limit.".into());
            }
        }
        let created_at = number(doc, &object, "createdAt")?;
        if created_at > 8_640_000_000_000_000 {
            return Err("The file creation time is out of range.".into());
        }
        records.push(FileRecord {
            id: id.into(),
            name,
            mime_type,
            size,
            sha256,
            created_at,
            deleted,
        });
    }
    records.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(records)
}

fn file_object(doc: &AutoCommit, id: &str) -> Result<ObjId> {
    if Uuid::parse_str(id).map_or(true, |parsed| parsed.to_string() != id) {
        return Err("Invalid shared-file ID.".into());
    }
    let values = doc
        .get_all(ROOT, format!("{PREFIX}{id}"))
        .map_err(message)?;
    match values.as_slice() {
        [(Value::Object(ObjType::Map), object)] => Ok(object.clone()),
        _ => Err("This shared file no longer exists or is invalid.".into()),
    }
}

fn text(doc: &AutoCommit, object: &ObjId, key: &str) -> Result<String> {
    let values = doc.get_all(object, key).map_err(message)?;
    if values.len() != 1 {
        return Err("Invalid or conflicting shared-file metadata.".into());
    }
    values
        .first()
        .and_then(|(value, _)| value.as_str())
        .map(str::to_owned)
        .ok_or("Invalid file text metadata.".into())
}

fn number(doc: &AutoCommit, object: &ObjId, key: &str) -> Result<u64> {
    let values = doc.get_all(object, key).map_err(message)?;
    if values.len() != 1 {
        return Err("Invalid or conflicting shared-file metadata.".into());
    }
    values
        .first()
        .and_then(|(value, _)| value.as_u64())
        .ok_or("Invalid numeric file metadata.".into())
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
