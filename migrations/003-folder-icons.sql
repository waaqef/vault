-- Adds: an icon (name or emoji) and a colour per folder.
ALTER TABLE folders ADD COLUMN icon TEXT;
ALTER TABLE folders ADD COLUMN color TEXT;
