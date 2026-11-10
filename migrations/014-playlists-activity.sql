-- Adds: playlists (tracks from any projects you can play, in your own order), and when each account was last active.
CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS playlist_tracks (playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, position REAL NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, PRIMARY KEY (playlist_id, track_id));
CREATE INDEX IF NOT EXISTS playlists_owner ON playlists (owner_id);
ALTER TABLE users ADD COLUMN last_seen INTEGER;
