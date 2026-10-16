-- Adds: a log of what happened in each project (shown to its owner and people), kept 90 days.
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, user_id TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS activity_project ON activity (project_id, created_at);
