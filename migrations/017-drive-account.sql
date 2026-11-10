-- Adds: which Google account each user's Drive is (its email). One Google account can only be connected to one
-- [vault] account; the unique index makes sure of that.
ALTER TABLE users ADD COLUMN drive_account TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_drive_account ON users (drive_account) WHERE drive_account IS NOT NULL;
