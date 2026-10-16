-- Adds: invite codes can be turned off (and back on) without deleting them.
ALTER TABLE invites ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
