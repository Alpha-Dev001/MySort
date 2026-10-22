-- Local metadata index.
--
-- The index is a cache of file *metadata* (path, name, size, timestamps and
-- an optional content hash). It is never the authority on whether a file
-- exists: every action taken on an indexed row re-checks the file on disk
-- first, and the index can be deleted and rebuilt at any time without
-- touching a single user file.
--
-- Nothing here stores file contents, and nothing leaves the machine.

CREATE TABLE file_index (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL COLLATE NOCASE UNIQUE,
  parent_dir   TEXT NOT NULL COLLATE NOCASE,
  name         TEXT NOT NULL,
  ext          TEXT NOT NULL DEFAULT '',
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  mtime_ms     INTEGER NOT NULL DEFAULT 0,
  ctime_ms     INTEGER NOT NULL DEFAULT 0,
  -- Content hash, when one has been computed. `hashed_size`/`hashed_mtime`
  -- record what the file looked like when it was hashed, so a cached hash is
  -- only reused while the file is provably unchanged.
  sha256       TEXT,
  hashed_size  INTEGER,
  hashed_mtime INTEGER,
  indexed_at   TEXT NOT NULL
);

CREATE INDEX idx_file_index_name   ON file_index(name COLLATE NOCASE);
CREATE INDEX idx_file_index_ext    ON file_index(ext);
CREATE INDEX idx_file_index_parent ON file_index(parent_dir COLLATE NOCASE);
CREATE INDEX idx_file_index_size   ON file_index(size_bytes);
CREATE INDEX idx_file_index_mtime  ON file_index(mtime_ms);
CREATE INDEX idx_file_index_ctime  ON file_index(ctime_ms);
CREATE INDEX idx_file_index_sha    ON file_index(sha256) WHERE sha256 IS NOT NULL;

-- Index bookkeeping: which roots are covered and when the last pass ran.
CREATE TABLE index_state (
  state_key   TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  TEXT NOT NULL
);
