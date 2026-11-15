//! The single durable store. Automerge history is retained byte-for-byte in SQLite.
use crate::incoming::{PendingShare, QueuedShare, MAX_PENDING_BYTES, MAX_PENDING_ITEMS};
use crate::schema::{
    app_state, file_blobs, incoming_shares, networks, recovery_drafts, settings, share_receipts,
};
use diesel::{connection::SimpleConnection, prelude::*, sqlite::SqliteConnection};
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use std::{fs, path::Path};

type Result<T> = std::result::Result<T, String>;
const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");
pub(crate) const DATABASE_NAME: &str = "murmur.sqlite3";

#[derive(Queryable, Selectable, Insertable)]
#[diesel(table_name = app_state)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(crate) struct StoredState {
    pub id: i32,
    pub device_id: String,
    pub active_network_id: Option<String>,
}

#[derive(Queryable, Selectable, Insertable, AsChangeset)]
#[diesel(table_name = networks)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(crate) struct StoredNetwork {
    pub id: String,
    pub name: String,
    pub protocol_version: i32,
    pub secret: Vec<u8>,
    pub document: Vec<u8>,
}

#[derive(Queryable, Selectable, Insertable, AsChangeset)]
#[diesel(table_name = recovery_drafts, primary_key(network_id))]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(crate) struct StoredDraft {
    pub network_id: String,
    pub note_id: String,
    pub title: String,
    pub body: String,
    pub base_heads: String,
}

#[derive(Queryable, Selectable, Insertable, AsChangeset)]
#[diesel(table_name = file_blobs, primary_key(network_id, sha256))]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub(crate) struct StoredBlob {
    pub network_id: String,
    pub sha256: String,
    pub size_bytes: i64,
    pub content: Vec<u8>,
}

#[derive(Clone, Copy)]
pub(crate) enum DraftClear<'a> {
    Saved(&'a StoredDraft),
    DeletedNote(&'a str),
}

pub(crate) struct Store {
    connection: SqliteConnection,
}

impl Store {
    pub fn pending_shares(&mut self) -> Result<Vec<PendingShare>> {
        incoming_shares::table
            .order(incoming_shares::created_at.asc())
            .select((
                incoming_shares::id,
                incoming_shares::name,
                incoming_shares::mime_type,
                diesel::dsl::sql::<diesel::sql_types::BigInt>("length(content)"),
            ))
            .load(&mut self.connection)
            .map_err(message)
    }

    pub fn pending_contents(&mut self) -> Result<Vec<QueuedShare>> {
        incoming_shares::table
            .order(incoming_shares::created_at.asc())
            .select(QueuedShare::as_select())
            .load(&mut self.connection)
            .map_err(message)
    }

    pub fn stage_shares(&mut self, shares: &[QueuedShare]) -> Result<()> {
        let ids: Vec<_> = shares.iter().map(|share| &share.id).collect();
        let known: std::collections::HashSet<String> = share_receipts::table
            .filter(share_receipts::id.eq_any(ids))
            .select(share_receipts::id)
            .load::<String>(&mut self.connection)
            .map_err(message)?
            .into_iter()
            .collect();
        let fresh: Vec<_> = shares
            .iter()
            .filter(|share| !known.contains(&share.id))
            .collect();
        let pending = self.pending_shares()?;
        let mut size = pending
            .iter()
            .try_fold(0u64, |sum, item| {
                sum.checked_add(u64::try_from(item.size).ok()?)
            })
            .ok_or("The share inbox size is invalid.")?;
        for share in &fresh {
            size = size
                .checked_add(u64::try_from(share.content.len()).map_err(message)?)
                .ok_or("The share inbox is full.")?;
        }
        if pending.len() + fresh.len() > MAX_PENDING_ITEMS || size > MAX_PENDING_BYTES {
            return Err(
                "The share inbox is full. Import or discard its files before sharing more.".into(),
            );
        }
        self.connection
            .transaction::<_, diesel::result::Error, _>(|connection| {
                for share in fresh {
                    diesel::insert_into(incoming_shares::table)
                        .values(share)
                        .execute(connection)?;
                    diesel::insert_into(share_receipts::table)
                        .values(share_receipts::id.eq(&share.id))
                        .execute(connection)?;
                }
                Ok(())
            })
            .map_err(message)
    }

    pub fn discard_pending_shares(&mut self) -> Result<()> {
        diesel::delete(incoming_shares::table)
            .execute(&mut self.connection)
            .map(|_| ())
            .map_err(message)
    }

    pub fn import_pending_shares(
        &mut self,
        network: &StoredNetwork,
        blobs: &[StoredBlob],
        ids: &[String],
    ) -> Result<()> {
        self.connection
            .transaction::<_, diesel::result::Error, _>(|connection| {
                diesel::update(networks::table.find(&network.id))
                    .set(network)
                    .execute(connection)?;
                for blob in blobs {
                    upsert_blob(connection, blob)?;
                }
                diesel::delete(incoming_shares::table.filter(incoming_shares::id.eq_any(ids)))
                    .execute(connection)?;
                Ok(())
            })
            .map_err(message)
    }

    pub fn open(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory).map_err(message)?;
        let path = directory.join(DATABASE_NAME);
        // Pre-create the database privately. SQLite uses its mode for WAL/journal
        // files too, so neither the network secret nor recovery drafts are public.
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(message(error)),
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(message)?;
        }
        let location = path
            .to_str()
            .ok_or("The app data path is not valid Unicode.")?;
        let mut connection = SqliteConnection::establish(location).map_err(message)?;
        connection
            .batch_execute(
                "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; \
                 PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
            )
            .map_err(message)?;
        connection
            .run_pending_migrations(MIGRATIONS)
            .map_err(message)?;
        Ok(Self { connection })
    }

    pub fn state(&mut self) -> Result<Option<StoredState>> {
        app_state::table
            .find(1)
            .select(StoredState::as_select())
            .first(&mut self.connection)
            .optional()
            .map_err(message)
    }

    /// Initialize identity and every imported archive as one durable operation.
    /// A failed insertion never leaves a partially imported notebook collection.
    pub fn initialize(&mut self, state: &StoredState, saved: &[StoredNetwork]) -> Result<()> {
        self.connection
            .transaction::<_, diesel::result::Error, _>(|connection| {
                for network in saved {
                    diesel::insert_into(networks::table)
                        .values(network)
                        .execute(connection)?;
                }
                diesel::insert_into(app_state::table)
                    .values(state)
                    .execute(connection)?;
                Ok(())
            })
            .map_err(message)
    }

    pub fn network(&mut self, id: &str) -> Result<Option<StoredNetwork>> {
        networks::table
            .find(id)
            .select(StoredNetwork::as_select())
            .first(&mut self.connection)
            .optional()
            .map_err(message)
    }

    pub fn save_network(
        &mut self,
        network: &StoredNetwork,
        activate: bool,
        draft_clear: Option<DraftClear<'_>>,
        blob: Option<&StoredBlob>,
        live_hashes: &[String],
    ) -> Result<()> {
        self.connection
            .transaction::<_, diesel::result::Error, _>(|connection| {
                diesel::insert_into(networks::table)
                    .values(network)
                    .on_conflict(networks::id)
                    .do_update()
                    .set(network)
                    .execute(connection)?;
                if activate {
                    diesel::update(app_state::table.find(1))
                        .set(app_state::active_network_id.eq(Some(&network.id)))
                        .execute(connection)?;
                }
                if let Some(DraftClear::Saved(draft)) = draft_clear {
                    // A newer editor backup must survive a save already in flight.
                    diesel::delete(
                        recovery_drafts::table
                            .filter(recovery_drafts::network_id.eq(&draft.network_id))
                            .filter(recovery_drafts::note_id.eq(&draft.note_id))
                            .filter(recovery_drafts::title.eq(&draft.title))
                            .filter(recovery_drafts::body.eq(&draft.body))
                            .filter(recovery_drafts::base_heads.eq(&draft.base_heads)),
                    )
                    .execute(connection)?;
                }
                if let Some(DraftClear::DeletedNote(note_id)) = draft_clear {
                    diesel::delete(
                        recovery_drafts::table
                            .filter(recovery_drafts::network_id.eq(&network.id))
                            .filter(recovery_drafts::note_id.eq(note_id)),
                    )
                    .execute(connection)?;
                }
                if let Some(blob) = blob {
                    upsert_blob(connection, blob)?;
                }
                // Tombstones retain CRDT history, but unreferenced content is
                // removed in the same transaction as its last metadata reference.
                diesel::delete(
                    file_blobs::table
                        .filter(file_blobs::network_id.eq(&network.id))
                        .filter(file_blobs::sha256.ne_all(live_hashes)),
                )
                .execute(connection)?;
                Ok(())
            })
            .map_err(message)
    }

    pub fn draft(&mut self, network_id: &str) -> Result<Option<StoredDraft>> {
        recovery_drafts::table
            .find(network_id)
            .select(StoredDraft::as_select())
            .first(&mut self.connection)
            .optional()
            .map_err(message)
    }

    pub fn save_draft(&mut self, draft: &StoredDraft, replace: bool) -> Result<()> {
        if !replace {
            return diesel::insert_into(recovery_drafts::table)
                .values(draft)
                .on_conflict(recovery_drafts::network_id)
                .do_nothing()
                .execute(&mut self.connection)
                .map(|_| ())
                .map_err(message);
        }
        diesel::insert_into(recovery_drafts::table)
            .values(draft)
            .on_conflict(recovery_drafts::network_id)
            .do_update()
            .set(draft)
            .execute(&mut self.connection)
            .map(|_| ())
            .map_err(message)
    }

    pub fn clear_draft(&mut self, network_id: &str, note_id: &str) -> Result<()> {
        diesel::delete(
            recovery_drafts::table
                .filter(recovery_drafts::network_id.eq(network_id))
                .filter(recovery_drafts::note_id.eq(note_id)),
        )
        .execute(&mut self.connection)
        .map(|_| ())
        .map_err(message)
    }

    pub fn blob_catalog(&mut self, network_id: &str) -> Result<Vec<(String, i64)>> {
        file_blobs::table
            .filter(file_blobs::network_id.eq(network_id))
            .select((file_blobs::sha256, file_blobs::size_bytes))
            .load(&mut self.connection)
            .map_err(message)
    }

    pub fn blob(&mut self, network_id: &str, hash: &str) -> Result<Option<StoredBlob>> {
        file_blobs::table
            .find((network_id, hash))
            .select(StoredBlob::as_select())
            .first(&mut self.connection)
            .optional()
            .map_err(message)
    }

    pub fn save_blob(&mut self, blob: &StoredBlob) -> Result<()> {
        upsert_blob(&mut self.connection, blob)
            .map(|_| ())
            .map_err(message)
    }

    pub fn theme(&mut self) -> Result<String> {
        settings::table
            .find(1)
            .select(settings::theme)
            .first(&mut self.connection)
            .map_err(message)
    }

    pub fn set_theme(&mut self, theme: &str) -> Result<()> {
        diesel::update(settings::table.find(1))
            .set(settings::theme.eq(theme))
            .execute(&mut self.connection)
            .map(|_| ())
            .map_err(message)
    }
}

fn upsert_blob(connection: &mut SqliteConnection, blob: &StoredBlob) -> diesel::QueryResult<usize> {
    diesel::insert_into(file_blobs::table)
        .values(blob)
        .on_conflict((file_blobs::network_id, file_blobs::sha256))
        .do_update()
        .set(blob)
        .execute(connection)
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
