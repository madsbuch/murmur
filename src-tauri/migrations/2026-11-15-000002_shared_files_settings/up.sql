CREATE TABLE file_blobs (
    network_id TEXT NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 26214400),
    content BLOB NOT NULL CHECK (length(content) = size_bytes),
    PRIMARY KEY (network_id, sha256)
) STRICT;

CREATE TABLE settings (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark'))
) STRICT;
INSERT INTO settings (id, theme) VALUES (1, 'system');
