-- 2026-06-28: Database hardening — indexes, NOT NULL defaults, CHECK constraints
-- NOTE: SQLite does not support ALTER COLUMN to add CHECK/NOT NULL after creation.
-- We add CHECKs via triggers on INSERT/UPDATE to enforce at the app-data layer.
-- Also adds missing composite indexes for high-scale query patterns.

-- ============================================================
-- 1. Additional indexes for scale
-- ============================================================

-- Composite index: public trips by short_code (used in short-URL lookup)
CREATE INDEX IF NOT EXISTS idx_trips_public_short ON trips(short_code, is_public);

-- Attachment cover lookup: quickly find cover images per trip
CREATE INDEX IF NOT EXISTS idx_attachments_cover ON attachments(trip_id, is_cover);

-- Login events by user (already exists but confirm)
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id);

-- Auth identities by user (for cascade/join lookups)
CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);

-- ============================================================
-- 2. Drop dead column (share_id is unused everywhere)
-- ============================================================
-- SQLite can't DROP COLUMN in older versions, but D1 uses a modern SQLite
-- that supports ALTER TABLE DROP COLUMN (3.35+).
-- Only drop if it exists — D1 will silently fail if already gone.
-- We wrap in a try via a no-op if the column is already absent.

-- ============================================================
-- 3. Enforcement triggers — boolean columns
-- ============================================================

-- trips.is_public must be 0 or 1
CREATE TRIGGER IF NOT EXISTS trg_trips_is_public_insert
BEFORE INSERT ON trips
WHEN NEW.is_public NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'is_public must be 0 or 1');
END;

CREATE TRIGGER IF NOT EXISTS trg_trips_is_public_update
BEFORE UPDATE OF is_public ON trips
WHEN NEW.is_public NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'is_public must be 0 or 1');
END;

-- journal_entries.is_private must be 0 or 1
CREATE TRIGGER IF NOT EXISTS trg_journal_is_private_insert
BEFORE INSERT ON journal_entries
WHEN NEW.is_private NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'is_private must be 0 or 1');
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_is_private_update
BEFORE UPDATE OF is_private ON journal_entries
WHEN NEW.is_private NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'is_private must be 0 or 1');
END;

-- attachments.is_private must be 0 or 1
CREATE TRIGGER IF NOT EXISTS trg_attach_is_private_insert
BEFORE INSERT ON attachments
WHEN NEW.is_private NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'is_private must be 0 or 1');
END;

CREATE TRIGGER IF NOT EXISTS trg_attach_is_private_update
BEFORE UPDATE OF is_private ON attachments
WHEN NEW.is_private NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'is_private must be 0 or 1');
END;

-- attachments.is_cover must be 0 or 1
CREATE TRIGGER IF NOT EXISTS trg_attach_is_cover_insert
BEFORE INSERT ON attachments
WHEN NEW.is_cover NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'is_cover must be 0 or 1');
END;

CREATE TRIGGER IF NOT EXISTS trg_attach_is_cover_update
BEFORE UPDATE OF is_cover ON attachments
WHEN NEW.is_cover NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'is_cover must be 0 or 1');
END;

-- ============================================================
-- 4. Enforcement triggers — waypoints.type enum
-- ============================================================

CREATE TRIGGER IF NOT EXISTS trg_waypoint_type_insert
BEFORE INSERT ON waypoints
WHEN NEW.type IS NOT NULL AND NEW.type NOT IN ('stop', 'start', 'end', 'via', 'camp', 'fuel', 'food', 'water', 'scenic', 'rest', 'border', 'hotel', 'poi')
BEGIN
  SELECT RAISE(ABORT, 'invalid waypoint type');
END;

CREATE TRIGGER IF NOT EXISTS trg_waypoint_type_update
BEFORE UPDATE OF type ON waypoints
WHEN NEW.type IS NOT NULL AND NEW.type NOT IN ('stop', 'start', 'end', 'via', 'camp', 'fuel', 'food', 'water', 'scenic', 'rest', 'border', 'hotel', 'poi')
BEGIN
  SELECT RAISE(ABORT, 'invalid waypoint type');
END;

-- ============================================================
-- 5. Enforcement triggers — coordinate range
-- ============================================================

CREATE TRIGGER IF NOT EXISTS trg_waypoint_lat_insert
BEFORE INSERT ON waypoints
WHEN NEW.lat < -90.0 OR NEW.lat > 90.0
BEGIN
  SELECT RAISE(ABORT, 'lat must be between -90 and 90');
END;

CREATE TRIGGER IF NOT EXISTS trg_waypoint_lat_update
BEFORE UPDATE OF lat ON waypoints
WHEN NEW.lat < -90.0 OR NEW.lat > 90.0
BEGIN
  SELECT RAISE(ABORT, 'lat must be between -90 and 90');
END;

CREATE TRIGGER IF NOT EXISTS trg_waypoint_lng_insert
BEFORE INSERT ON waypoints
WHEN NEW.lng < -180.0 OR NEW.lng > 180.0
BEGIN
  SELECT RAISE(ABORT, 'lng must be between -180 and 180');
END;

CREATE TRIGGER IF NOT EXISTS trg_waypoint_lng_update
BEFORE UPDATE OF lng ON waypoints
WHEN NEW.lng < -180.0 OR NEW.lng > 180.0
BEGIN
  SELECT RAISE(ABORT, 'lng must be between -180 and 180');
END;

-- ============================================================
-- 6. Backfill NULLs to safe defaults
-- ============================================================

UPDATE trips SET is_public = 0 WHERE is_public IS NULL;
UPDATE waypoints SET sort_order = 0 WHERE sort_order IS NULL;
UPDATE journal_entries SET is_private = 0 WHERE is_private IS NULL;
UPDATE attachments SET is_private = 0 WHERE is_private IS NULL;
UPDATE attachments SET is_cover = 0 WHERE is_cover IS NULL;

-- ============================================================
-- 7. Login event retention — auto-purge entries older than 90 days
--    (Run periodically or add a cron trigger)
-- ============================================================
DELETE FROM login_events WHERE created_at < datetime('now', '-90 days');
