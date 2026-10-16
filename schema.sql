CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, icon TEXT, color TEXT, owner_id TEXT NOT NULL DEFAULT 'owner', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_id TEXT, cover TEXT, owner_id TEXT NOT NULL DEFAULT 'owner', created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  file_key TEXT NOT NULL, size INTEGER NOT NULL, duration REAL,
  bpm REAL, musical_key TEXT, tags TEXT NOT NULL DEFAULT '', cover TEXT,
  notes TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '', deleted_at INTEGER, peaks TEXT, mark TEXT,
  position REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS track_versions (
  id TEXT PRIMARY KEY, track_id TEXT NOT NULL, file_key TEXT NOT NULL,
  size INTEGER NOT NULL, duration REAL, note TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('project', 'track')),
  target_id TEXT NOT NULL, password_hash TEXT, expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0, allow_download INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS listens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, share_token TEXT NOT NULL,
  listener_name TEXT, track_id TEXT, at INTEGER NOT NULL, seconds REAL, duration REAL
);
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL, owner_id TEXT NOT NULL DEFAULT 'owner', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bandwidth (day TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, owner_id TEXT NOT NULL DEFAULT 'owner', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, share_token TEXT NOT NULL, track_id TEXT NOT NULL,
  name TEXT NOT NULL, at REAL, body TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_track ON comments (track_id, created_at);
CREATE INDEX IF NOT EXISTS tracks_deleted ON tracks (deleted_at);
CREATE INDEX IF NOT EXISTS projects_deleted ON projects (deleted_at);
CREATE INDEX IF NOT EXISTS tracks_project ON tracks (project_id);
CREATE INDEX IF NOT EXISTS versions_track ON track_versions (track_id);
CREATE INDEX IF NOT EXISTS shares_target ON shares (kind, target_id);
CREATE INDEX IF NOT EXISTS listens_share ON listens (share_token);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_salt TEXT, pass_hash TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
  avatar TEXT, storage TEXT NOT NULL DEFAULT 'drive', drive_refresh TEXT, drive_folder TEXT, session TEXT,
  upload_key TEXT, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_by TEXT NOT NULL, used_by TEXT, used_at INTEGER, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
INSERT OR IGNORE INTO users (id, username, is_admin, storage, created_at) VALUES ('owner', 'admin', 1, 'b2', 0);
CREATE INDEX IF NOT EXISTS projects_owner ON projects (owner_id);
CREATE INDEX IF NOT EXISTS folders_owner ON folders (owner_id);
CREATE INDEX IF NOT EXISTS versions_key ON track_versions (file_key);
CREATE TABLE IF NOT EXISTS saved_shares (user_id TEXT NOT NULL, token TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, token));
CREATE TABLE IF NOT EXISTS project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')), created_at INTEGER NOT NULL, PRIMARY KEY (project_id, user_id));
CREATE INDEX IF NOT EXISTS members_user ON project_members (user_id);
CREATE TABLE IF NOT EXISTS access_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, share_token TEXT, name TEXT NOT NULL, contact TEXT, message TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, user_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS activity_project ON activity (project_id, created_at);
