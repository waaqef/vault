-- Adds: trash, track notes + producer, share downloads, listen progress, password/upload-key config, login lockout.
ALTER TABLE tracks ADD COLUMN deleted_at INTEGER;
ALTER TABLE tracks ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE tracks ADD COLUMN artist TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
ALTER TABLE shares ADD COLUMN allow_download INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listens ADD COLUMN seconds REAL;
ALTER TABLE listens ADD COLUMN duration REAL;
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tracks_deleted ON tracks (deleted_at);
CREATE INDEX IF NOT EXISTS projects_deleted ON projects (deleted_at);
