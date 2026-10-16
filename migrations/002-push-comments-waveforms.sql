-- Adds: waveforms, star/throwaway marks, push notification subscriptions, timestamped comments on share links.
ALTER TABLE tracks ADD COLUMN peaks TEXT;
ALTER TABLE tracks ADD COLUMN mark TEXT; -- 'star' | 'throw' | NULL
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, share_token TEXT NOT NULL, track_id TEXT NOT NULL,
  name TEXT NOT NULL, at REAL, body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_track ON comments (track_id, created_at);
