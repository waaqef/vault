-- Adds: a running total of what's been downloaded from Backblaze each day (UTC), for the daily-limit guard.
CREATE TABLE IF NOT EXISTS bandwidth (day TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0);
