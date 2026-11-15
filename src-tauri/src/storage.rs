//! The single durable store. Automerge history is retained byte-for-byte in SQLite.
use crate::schema::{app_state, networks, recovery_drafts};
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

#[derive(Clone, Copy)]
pub(crate) enum DraftClear<'a> {
    Saved(&'a StoredDraft),
    DeletedNote(&'a str),
}

pub(crate) struct Store {
    connection: SqliteConnection,
}

impl Store {
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
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
