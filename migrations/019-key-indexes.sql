-- Adds: lookups by file key and cover, so finding / updating one file reads a row or two instead of the whole table
-- (moving files to Google Drive used up D1's free daily read allowance without these).
CREATE INDEX IF NOT EXISTS tracks_file ON tracks (file_key);
CREATE INDEX IF NOT EXISTS tracks_cover ON tracks (cover);
CREATE INDEX IF NOT EXISTS projects_cover ON projects (cover);
