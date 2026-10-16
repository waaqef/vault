-- Adds: people added to a project (viewer or editor), public share links, who wrote each comment,
-- and requests for an invite sent from share pages.
CREATE TABLE IF NOT EXISTS project_members (project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')), created_at INTEGER NOT NULL, PRIMARY KEY (project_id, user_id));
CREATE INDEX IF NOT EXISTS members_user ON project_members (user_id);
ALTER TABLE shares ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN user_id TEXT;
CREATE TABLE IF NOT EXISTS access_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, share_token TEXT, name TEXT NOT NULL, contact TEXT, message TEXT, created_at INTEGER NOT NULL);
