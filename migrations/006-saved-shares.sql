-- Adds: shared projects/tracks that a signed-in user saved to their library (a linked copy: it follows the share link).
CREATE TABLE IF NOT EXISTS saved_shares (user_id TEXT NOT NULL, token TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, token));
