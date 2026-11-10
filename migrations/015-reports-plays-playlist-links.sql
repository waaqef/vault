-- Adds: playlist share links (the shares table is rebuilt so its kind can be 'playlist'), reports of share links
-- (abuse / copyright, read by the admin), and plays inside the app (for analytics; kept a year).
CREATE TABLE shares_new (
  token TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('project', 'track', 'playlist')),
  target_id TEXT NOT NULL, password_hash TEXT, expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0, allow_download INTEGER NOT NULL DEFAULT 0, public INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
INSERT INTO shares_new (token, kind, target_id, password_hash, expires_at, revoked, allow_download, public, created_at)
  SELECT token, kind, target_id, password_hash, expires_at, revoked, allow_download, public, created_at FROM shares;
DROP TABLE shares;
ALTER TABLE shares_new RENAME TO shares;
CREATE INDEX IF NOT EXISTS shares_target ON shares (kind, target_id);
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, share_token TEXT NOT NULL, reason TEXT NOT NULL, details TEXT, contact TEXT, reporter_id TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, track_id TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS plays_at ON plays (at);
