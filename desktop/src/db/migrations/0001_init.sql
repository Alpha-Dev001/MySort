-- MySort initial schema. Timestamps are ISO 8601 UTC text.
-- The database stores paths, names, sizes and optional hashes, never file contents.

CREATE TABLE settings (
  setting_key TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  TEXT NOT NULL
);

CREATE TABLE monitored_folders (
  id                 INTEGER PRIMARY KEY,
  path               TEXT NOT NULL COLLATE NOCASE UNIQUE,
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  mode               TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','auto')),
  auto_since         TEXT,
  last_reconciled_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE category_destinations (
  category    TEXT PRIMARY KEY CHECK (category IN ('images','videos','documents','audio','archives','other')),
  path        TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE rules (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  extensions_json  TEXT NOT NULL CHECK (
                     json_valid(extensions_json) AND
                     json_array_length(extensions_json) BETWEEN 0 AND 50
                   ),
  name_pattern     TEXT CHECK (name_pattern IS NULL OR length(name_pattern) BETWEEN 1 AND 120),
  destination      TEXT NOT NULL CHECK (length(destination) > 0),
  destination_kind TEXT NOT NULL CHECK (destination_kind IN ('relative','absolute')),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  position         INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (json_array_length(extensions_json) > 0 OR name_pattern IS NOT NULL)
);
CREATE INDEX idx_rules_order ON rules(position, created_at, id);

CREATE TABLE operations (
  id                  TEXT PRIMARY KEY,
  batch_id            TEXT,
  monitored_folder_id INTEGER REFERENCES monitored_folders(id) ON DELETE SET NULL,
  initiated_by        TEXT NOT NULL CHECK (initiated_by IN ('auto','manual','retry','recovery','undo')),
  undo_of             TEXT REFERENCES operations(id),
  file_name           TEXT NOT NULL,
  source_path         TEXT NOT NULL,
  planned_dest_path   TEXT NOT NULL,
  final_dest_path     TEXT,
  rule_kind           TEXT NOT NULL CHECK (rule_kind IN ('custom','default','none')),
  rule_id             TEXT,
  rule_label          TEXT NOT NULL,
  explanation         TEXT NOT NULL,
  method              TEXT CHECK (method IN ('link_unlink','rename','copy_verify')),
  status              TEXT NOT NULL CHECK (status IN ('planned','in_progress','completed','failed','skipped','needs_review')),
  error_code          TEXT,
  error_detail        TEXT,
  size_bytes          INTEGER,
  mtime_ms            INTEGER,
  dest_mtime_ms       INTEGER,
  sha256              TEXT,
  undo_status         TEXT NOT NULL DEFAULT 'not_eligible' CHECK (undo_status IN ('not_eligible','available','done','blocked','expired')),
  undo_block_code     TEXT,
  created_at          TEXT NOT NULL,
  finished_at         TEXT
);
CREATE INDEX idx_ops_created ON operations(created_at DESC);
CREATE INDEX idx_ops_attention ON operations(status) WHERE status IN ('planned','in_progress','needs_review');
CREATE INDEX idx_ops_name ON operations(file_name COLLATE NOCASE);
CREATE INDEX idx_ops_today ON operations(finished_at);
-- Duplicate-processing guard: only one active operation per source path.
CREATE UNIQUE INDEX ux_ops_active_source ON operations(source_path COLLATE NOCASE)
  WHERE status IN ('planned','in_progress');
