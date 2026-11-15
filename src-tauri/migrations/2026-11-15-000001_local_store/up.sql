CREATE TABLE networks (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
    secret BLOB NOT NULL CHECK (length(secret) = 32),
    document BLOB NOT NULL CHECK (length(document) BETWEEN 1 AND 8388608)
) STRICT;

CREATE TABLE app_state (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    device_id TEXT NOT NULL,
    active_network_id TEXT REFERENCES networks(id)
) STRICT;

CREATE TABLE recovery_drafts (
    network_id TEXT PRIMARY KEY NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    base_heads TEXT NOT NULL
) STRICT;
