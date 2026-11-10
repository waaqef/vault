-- Adds: bug reports people send from the app (Settings → Report a bug), read by the admin.
CREATE TABLE IF NOT EXISTS bug_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, text TEXT NOT NULL, info TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
