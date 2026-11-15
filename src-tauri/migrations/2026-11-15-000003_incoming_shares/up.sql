CREATE TABLE incoming_shares (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    content BLOB NOT NULL CHECK (length(content) <= 26214400),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;
-- Retained after import/discard so a repeated OS handoff cannot import twice.
CREATE TABLE share_receipts (id TEXT PRIMARY KEY NOT NULL) STRICT;
