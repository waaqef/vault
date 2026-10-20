-- Adds: display names (what other people see; usernames stay unique for signing in and adding people).
ALTER TABLE users ADD COLUMN display_name TEXT;
