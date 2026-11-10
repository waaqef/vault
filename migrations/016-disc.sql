-- Adds: the disc a track is on, for albums with more than one (shown as [disc N] headings in the project).
ALTER TABLE tracks ADD COLUMN disc INTEGER;
