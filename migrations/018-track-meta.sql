-- Adds: what each file's own tags say (title, artist, producer, track, disc), read by Settings -> Read info from files.
ALTER TABLE tracks ADD COLUMN meta TEXT;
