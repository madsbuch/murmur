//! Native share extensions hand off bounded SQLite inboxes to the main store.
use crate::{engine::Engine, files, schema::incoming_shares};
use diesel::{
    connection::SimpleConnection,
    prelude::*,
    sql_types::{BigInt, Text},
};
use serde::Serialize;
use std::{collections::HashSet, path::Path};
use uuid::Uuid;

pub(crate) const MAX_PENDING_BYTES: u64 = 100 * 1024 * 1024;
pub(crate) const MAX_PENDING_ITEMS: usize = 32;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Queryable, Selectable, Insertable)]
#[diesel(table_name = incoming_shares)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(crate) struct QueuedShare {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub content: Vec<u8>,
    pub created_at: i64,
}

#[derive(Queryable, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingShare {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
}

pub(crate) fn validate(items: &[QueuedShare]) -> Result<()> {
    if items.len() > MAX_PENDING_ITEMS {
        return Err("Share up to 32 files at a time.".into());
    }
    let mut ids = HashSet::new();
    let mut total = 0u64;
    for item in items {
        if Uuid::parse_str(&item.id).map_err(message)?.to_string() != item.id
            || !ids.insert(&item.id)
        {
            return Err("The shared-file handoff contains an invalid or duplicate ID.".into());
        }
        files::validate_name_mime(&item.name, &item.mime_type)?;
        if item.content.len() > files::MAX_FILE_BYTES || item.created_at < 0 {
            return Err("Each shared file must be no larger than 25 MiB.".into());
        }
        total = total
            .checked_add(u64::try_from(item.content.len()).map_err(message)?)
            .ok_or("Shared files exceed the inbox limit.")?;
        if total > MAX_PENDING_BYTES {
            return Err("Shared files exceed the 100 MiB inbox limit.".into());
        }
    }
    Ok(())
}

/// Returns only after every selected item has a durable idempotency receipt.
/// If acknowledgement fails, the next attempt safely skips those same IDs.
pub(crate) fn receive_database(engine: &Engine, path: &Path, transfer_file: bool) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    if path.metadata().map_err(message)?.len() > 110 * 1024 * 1024 {
        return Err("The native share inbox is too large.".into());
    }
    let location = path
        .to_str()
        .ok_or("The share inbox path is not valid Unicode.")?;
    let mut connection = SqliteConnection::establish(location).map_err(message)?;
    connection
        .batch_execute("PRAGMA busy_timeout=5000;")
        .map_err(message)?;
    #[derive(QueryableByName)]
    struct ObjectKind {
        #[diesel(sql_type = Text)]
        kind: String,
    }
    #[derive(QueryableByName)]
    struct Column {
        #[diesel(sql_type = Text)]
        name: String,
        #[diesel(sql_type = diesel::sql_types::Integer)]
        hidden: i32,
    }
    let items = connection
        .transaction::<_, diesel::result::Error, _>(|connection| {
            // sqlite_schema calls virtual tables "table" too. table_list
            // distinguishes them, preventing an FTS external-content view from
            // allocating an arbitrary blob during the length preflight.
            let kind = diesel::sql_query("SELECT type AS kind FROM pragma_table_list WHERE schema='main' AND name='incoming_shares'")
                .get_result::<ObjectKind>(connection)?;
            let columns = diesel::sql_query("SELECT name, hidden FROM pragma_table_xinfo('incoming_shares')")
                .load::<Column>(connection)?;
            let expected = ["id", "name", "mime_type", "content", "created_at"];
            if kind.kind != "table" || columns.len() != expected.len()
                || columns.iter().any(|column| column.hidden != 0 || !expected.contains(&column.name.as_str())) {
                return Err(diesel::result::Error::RollbackTransaction);
            }
            // The five fields must be stored columns, never computed values.
            let invalid = incoming_shares::table.filter(diesel::dsl::sql::<diesel::sql_types::Bool>(
                "typeof(id) != 'text' OR length(id) != 36 OR typeof(name) != 'text' OR length(name) > 255 OR typeof(mime_type) != 'text' OR length(mime_type) > 127 OR typeof(content) != 'blob' OR typeof(created_at) != 'integer' OR created_at < 0"))
                .select(incoming_shares::id).limit(1).load::<String>(connection)?;
            if !invalid.is_empty() { return Err(diesel::result::Error::RollbackTransaction); }
            let lengths = incoming_shares::table
                .select(diesel::dsl::sql::<BigInt>("length(content)"))
                .limit(33)
                .load::<i64>(connection)?;
            let total = lengths.iter().try_fold(0u64, |sum, value| {
                let size = u64::try_from(*value).ok()?;
                if size > 25 * 1024 * 1024 {
                    return None;
                }
                sum.checked_add(size)
            });
            if lengths.len() > MAX_PENDING_ITEMS || total.is_none_or(|sum| sum > MAX_PENDING_BYTES)
            {
                return Err(diesel::result::Error::RollbackTransaction);
            }
            incoming_shares::table
                .select(QueuedShare::as_select())
                .load::<QueuedShare>(connection)
        })
        .map_err(|_| "The native share inbox is invalid or exceeds the file limits.".to_string())?;
    validate(&items)?;
    engine.stage_incoming(&items)?;
    if transfer_file {
        // Only the extension deletes its own staging directory. Opening an
        // unrelated .murmur-share file must never delete the user's original.
        let marker = path.with_extension("murmur-share.received");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(marker) {
            Ok(file) => file.sync_all().map_err(message)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(message(error)),
        }
        return Ok(());
    }
    let ids: Vec<_> = items.iter().map(|item| &item.id).collect();
    diesel::delete(incoming_shares::table.filter(incoming_shares::id.eq_any(ids)))
        .execute(&mut connection)
        .map_err(message)?;
    Ok(())
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn share() -> QueuedShare {
        QueuedShare {
            id: Uuid::new_v4().to_string(),
            name: "Screenshot.png".into(),
            mime_type: "image/png".into(),
            content: b"synthetic shared bytes".to_vec(),
            created_at: 1,
        }
    }
    fn source(path: &Path, item: &QueuedShare) {
        let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        db.batch_execute("CREATE TABLE incoming_shares(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,mime_type TEXT NOT NULL,content BLOB NOT NULL,created_at INTEGER NOT NULL);").unwrap();
        diesel::insert_into(incoming_shares::table)
            .values(item)
            .execute(&mut db)
            .unwrap();
    }

    #[test]
    fn incoming_files_wait_offline_then_import_once_even_after_repeated_handoff() {
        let dir = tempfile::tempdir().unwrap();
        let item = share();
        {
            let engine = Engine::open(dir.path().into()).unwrap();
            engine.stage_incoming(std::slice::from_ref(&item)).unwrap();
            engine.stage_incoming(std::slice::from_ref(&item)).unwrap();
            assert_eq!(engine.pending_shares().unwrap().len(), 1);
        }
        let engine = Engine::open(dir.path().into()).unwrap();
        assert_eq!(engine.pending_shares().unwrap().len(), 1);
        let network = engine
            .create_network("Inbox".into())
            .unwrap()
            .network
            .unwrap();
        let snapshot = engine.import_pending_shares(network.id.clone()).unwrap();
        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(
            engine
                .read_file_bytes(network.id.clone(), snapshot.files[0].id.clone())
                .unwrap()
                .2,
            item.content
        );
        assert!(engine.pending_shares().unwrap().is_empty());
        engine.stage_incoming(std::slice::from_ref(&item)).unwrap();
        assert!(engine.pending_shares().unwrap().is_empty());
        assert_eq!(
            engine
                .import_pending_shares(network.id)
                .unwrap()
                .files
                .len(),
            1
        );
    }

    #[test]
    fn incoming_import_is_atomic_and_rejects_a_changed_network() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path().into()).unwrap();
        let old = engine
            .create_network("Old".into())
            .unwrap()
            .network
            .unwrap();
        engine.stage_incoming(&[share(), share()]).unwrap();
        let current = engine
            .create_network("Current".into())
            .unwrap()
            .network
            .unwrap();
        assert!(engine.import_pending_shares(old.id).is_err());
        let mut db =
            SqliteConnection::establish(dir.path().join("murmur.sqlite3").to_str().unwrap())
                .unwrap();
        db.batch_execute("CREATE TRIGGER fail_inbox BEFORE INSERT ON file_blobs BEGIN SELECT RAISE(ABORT,'test rollback'); END;").unwrap();
        assert!(engine.import_pending_shares(current.id.clone()).is_err());
        assert_eq!(engine.pending_shares().unwrap().len(), 2);
        assert!(engine.snapshot().unwrap().files.is_empty());
        db.batch_execute("DROP TRIGGER fail_inbox;").unwrap();
        assert_eq!(
            engine
                .import_pending_shares(current.id)
                .unwrap()
                .files
                .len(),
            2
        );
        assert!(engine.pending_shares().unwrap().is_empty());
    }

    #[test]
    fn durable_staging_precedes_native_ack_and_discard_does_not_reimport() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path().into()).unwrap();
        let item = share();
        let path = dir.path().join("transfer.murmur-share");
        source(&path, &item);
        receive_database(&engine, &path, true).unwrap();
        assert!(path.exists());
        assert!(path.with_extension("murmur-share.received").exists());
        assert_eq!(engine.pending_shares().unwrap().len(), 1);
        engine.discard_pending_shares().unwrap();
        receive_database(&engine, &path, true).unwrap();
        assert!(engine.pending_shares().unwrap().is_empty());
    }

    #[test]
    fn failed_staging_preserves_the_native_handoff() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path().into()).unwrap();
        let existing: Vec<_> = (0..32).map(|_| share()).collect();
        engine.stage_incoming(&existing).unwrap();
        let path = dir.path().join("transfer.murmur-share");
        source(&path, &share());
        assert!(receive_database(&engine, &path, true).is_err());
        assert!(path.exists());
        engine.discard_pending_shares().unwrap();
        receive_database(&engine, &path, true).unwrap();
        assert_eq!(engine.pending_shares().unwrap().len(), 1);
    }

    #[test]
    fn rejects_sql_views_and_oversized_or_invalid_handoffs() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path().into()).unwrap();
        let path = dir.path().join("hostile.murmur-share");
        let mut db = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        db.batch_execute(
            "CREATE VIEW incoming_shares AS SELECT randomblob(1000000000) AS content;",
        )
        .unwrap();
        assert!(receive_database(&engine, &path, true).is_err());
        assert!(path.exists());
        db.batch_execute("DROP VIEW incoming_shares; CREATE VIEW payload AS SELECT 'x' AS id, 'x' AS name, 'x' AS mime_type, randomblob(1048576) AS content, 1 AS created_at; CREATE VIRTUAL TABLE incoming_shares USING fts5(id, name, mime_type, content, created_at, content='payload');").unwrap();
        assert!(receive_database(&engine, &path, true).is_err());
        db.batch_execute("DROP TABLE incoming_shares; CREATE TABLE incoming_shares(id TEXT,name TEXT,mime_type TEXT,content BLOB GENERATED ALWAYS AS (zeroblob(1048576)) VIRTUAL,created_at INTEGER);").unwrap();
        assert!(receive_database(&engine, &path, true).is_err());
        let too_many: Vec<_> = (0..33).map(|_| share()).collect();
        assert!(engine.stage_incoming(&too_many).is_err());
        let mut invalid = share();
        invalid.name = "../not-allowed".into();
        assert!(engine.stage_incoming(&[invalid]).is_err());
        assert!(engine.pending_shares().unwrap().is_empty());
    }
}
