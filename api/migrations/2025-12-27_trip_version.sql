-- Add optimistic concurrency control to trips
-- Allows clients to prevent stale devices/tabs from overwriting newer changes.

ALTER TABLE trips ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
