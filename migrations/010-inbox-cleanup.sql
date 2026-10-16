-- Adds: an inbox of notifications per person. Removes leftovers: the old daily-download counter, and the unused invite on/off column.
CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT, url TEXT, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS inbox_user ON inbox (user_id, created_at);
DROP TABLE IF EXISTS bandwidth;
ALTER TABLE invites DROP COLUMN disabled;
