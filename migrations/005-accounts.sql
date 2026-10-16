-- Adds: accounts. The existing owner becomes the admin user 'owner' (Backblaze storage); everything is backfilled to them.
-- Invited users sign up with a code and keep their music in their own Google Drive.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_salt TEXT, pass_hash TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
  avatar TEXT, storage TEXT NOT NULL DEFAULT 'drive', drive_refresh TEXT, drive_folder TEXT, session TEXT,
  upload_key TEXT, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_by TEXT NOT NULL, used_by TEXT, used_at INTEGER, created_at INTEGER NOT NULL);
INSERT OR IGNORE INTO users (id, username, is_admin, storage, upload_key, created_at)
  VALUES ('owner', 'admin', 1, 'b2', (SELECT value FROM config WHERE key = 'upload_key'), 0);
ALTER TABLE folders ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE projects ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE presets ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE push_subs ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'owner';
CREATE INDEX IF NOT EXISTS projects_owner ON projects (owner_id);
CREATE INDEX IF NOT EXISTS folders_owner ON folders (owner_id);
CREATE INDEX IF NOT EXISTS versions_key ON track_versions (file_key);
