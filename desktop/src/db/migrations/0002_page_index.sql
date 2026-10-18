-- History paging support.
--
-- The history list is ordered by `created_at DESC, id DESC`. The original
-- index covers only `created_at`, so SQLite has to sort each group of rows
-- that share a timestamp before it can page through them. Two files moved in
-- the same millisecond is the normal case, not an edge case.
--
-- A composite index lets SQLite walk the pages in order and stop at LIMIT,
-- which is what keeps "go to page 400" instant as history grows.

CREATE INDEX IF NOT EXISTS idx_ops_created_id ON operations(created_at DESC, id DESC);
