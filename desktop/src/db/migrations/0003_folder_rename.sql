-- Rename tracking for watched folders.
--
-- When the user renames a watched folder (or moves it), MySort has to keep
-- sorting from the same folder instead of losing it or adding a new one. The
-- journal already points at the folder row (monitored_folder_id), so the row
-- is kept and only its path is updated.
--
-- `parent_dirs_json` stores the names of the parent directory's subfolders as
-- they were at the last successful reconciliation scan. If the app was closed
-- while the folder was renamed, boot recovery pairs the one subfolder that
-- disappeared with the one that appeared and follows the folder to its new
-- name — the same pairing the live watcher does.

ALTER TABLE monitored_folders ADD COLUMN parent_dirs_json TEXT;
