-- Virtual collections and rule recommendations.
--
-- A collection is a *reference* to files, never a copy and never a move: the
-- files stay exactly where they are and the collection only points at them.
--
-- A recommendation is a suggestion derived from repeated user-approved moves.
-- Recommendations are never activated automatically — the row only exists so
-- the app can show the evidence, and the user has to accept it before a rule
-- is created.

CREATE TABLE collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Rule-based membership. `position` keeps the user's order.
CREATE TABLE collection_rules (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('extension','name_contains','parent','my_sort_rule')),
  value         TEXT NOT NULL CHECK (length(value) > 0),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_collection_rules ON collection_rules(collection_id, position);

-- Files added by hand. The path may stop existing later; that is reported,
-- not repaired.
CREATE TABLE collection_members (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  path          TEXT NOT NULL COLLATE NOCASE,
  added_at      TEXT NOT NULL,
  PRIMARY KEY (collection_id, path)
);
CREATE INDEX idx_collection_members_path ON collection_members(path COLLATE NOCASE);

CREATE TABLE recommendations (
  id            TEXT PRIMARY KEY,
  -- Stable identity of the pattern. A dismissed recommendation keeps its
  -- fingerprint, so the same pattern is not offered again.
  fingerprint   TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'rule',
  payload_json  TEXT NOT NULL CHECK (json_valid(payload_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','dismissed')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_recommendations_status ON recommendations(status, updated_at DESC);
