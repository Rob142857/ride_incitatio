-- =============================================================================
-- Migration: v1 → v2  (run via wrangler d1 execute)
-- =============================================================================
-- This migration adds CHECK constraints, triggers, and views to the existing
-- schema.  It is safe to run multiple times (IF NOT EXISTS / OR IGNORE).
--
-- Because SQLite cannot ALTER COLUMN to add CHECK constraints on existing
-- tables, the migration strategy is:
--   1. Add new triggers and views (safe, additive)
--   2. Add missing columns with defaults (safe, additive)
--   3. Add missing indexes (safe, additive)
--   4. Drop the dead short_urls table
--   5. Drop the dead share_id column (requires table rebuild — deferred)
--
-- For a full fresh deploy, use schema_v2.sql instead.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- A. Add missing column: cover_focus_x, cover_focus_y
-- ---------------------------------------------------------------------------
-- These may already exist; ALTER TABLE ADD COLUMN is safe if they don't.
-- SQLite will error if the column already exists, so we wrap in a try
-- by using a conditional approach.

-- Note: D1 doesn't support IF NOT EXISTS on ALTER TABLE ADD COLUMN,
-- so we must accept that these may fail on re-run.  The wrangler CLI
-- will report the error but continue.  Alternatively, check beforehand.

-- ALTER TABLE trips ADD COLUMN cover_focus_x INTEGER NOT NULL DEFAULT 50;
-- ALTER TABLE trips ADD COLUMN cover_focus_y INTEGER NOT NULL DEFAULT 50;

-- ---------------------------------------------------------------------------
-- B. Drop dead table
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS short_urls;

-- ---------------------------------------------------------------------------
-- C. Triggers: auto-bump trips.version + updated_at on child mutations
-- ---------------------------------------------------------------------------

-- C1. Trips self-update trigger
CREATE TRIGGER IF NOT EXISTS trg_trips_updated
AFTER UPDATE ON trips
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at  -- prevent infinite loop
BEGIN
  UPDATE trips
  SET updated_at = datetime('now'),
      version    = version + 1
  WHERE id = NEW.id;
END;

-- C2. Waypoint triggers
CREATE TRIGGER IF NOT EXISTS trg_waypoints_insert_bump
AFTER INSERT ON waypoints
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = NEW.trip_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_waypoints_update_bump
AFTER UPDATE ON waypoints
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = NEW.trip_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_waypoints_delete_bump
AFTER DELETE ON waypoints
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = OLD.trip_id;
END;

-- C3. Journal entry triggers
CREATE TRIGGER IF NOT EXISTS trg_journal_updated
AFTER UPDATE ON journal_entries
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE journal_entries SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_insert_bump
AFTER INSERT ON journal_entries
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = NEW.trip_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_update_bump
AFTER UPDATE ON journal_entries
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = NEW.trip_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_journal_delete_bump
AFTER DELETE ON journal_entries
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = OLD.trip_id;
END;

-- C4. Attachment triggers
CREATE TRIGGER IF NOT EXISTS trg_attachments_insert_bump
AFTER INSERT ON attachments
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = NEW.trip_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_attachments_delete_bump
AFTER DELETE ON attachments
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = OLD.trip_id;
END;

-- C5. Route data triggers
CREATE TRIGGER IF NOT EXISTS trg_route_data_updated
AFTER UPDATE ON route_data
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE route_data SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_route_insert_bump
AFTER INSERT ON route_data
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = NEW.trip_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_route_update_bump
AFTER UPDATE ON route_data
FOR EACH ROW
BEGIN
  UPDATE trips SET updated_at = datetime('now'), version = version + 1
  WHERE id = NEW.trip_id;
END;

-- ---------------------------------------------------------------------------
-- D. Cover image auto-management triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_attachment_single_cover_insert
AFTER INSERT ON attachments
WHEN NEW.is_cover = 1
BEGIN
  UPDATE attachments SET is_cover = 0
  WHERE trip_id = NEW.trip_id AND id != NEW.id AND is_cover = 1;
  UPDATE trips SET cover_image_url = 'https://ride.incitat.io/api/attachments/' || NEW.id
  WHERE id = NEW.trip_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_attachment_single_cover_update
AFTER UPDATE OF is_cover ON attachments
WHEN NEW.is_cover = 1 AND OLD.is_cover = 0
BEGIN
  UPDATE attachments SET is_cover = 0
  WHERE trip_id = NEW.trip_id AND id != NEW.id AND is_cover = 1;
  UPDATE trips SET cover_image_url = 'https://ride.incitat.io/api/attachments/' || NEW.id
  WHERE id = NEW.trip_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_attachment_cover_delete
AFTER DELETE ON attachments
WHEN OLD.is_cover = 1
BEGIN
  UPDATE trips SET cover_image_url = (
    SELECT 'https://ride.incitat.io/api/attachments/' || a.id
    FROM attachments a
    WHERE a.trip_id = OLD.trip_id AND a.is_cover = 1
    ORDER BY a.created_at DESC
    LIMIT 1
  )
  WHERE id = OLD.trip_id;
END;

-- ---------------------------------------------------------------------------
-- E. Additional indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_trips_public       ON trips(is_public)  WHERE is_public = 1;
CREATE INDEX IF NOT EXISTS idx_waypoints_trip_sort ON waypoints(trip_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_journal_trip_date   ON journal_entries(trip_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_cover   ON attachments(trip_id, is_cover) WHERE is_cover = 1;
CREATE INDEX IF NOT EXISTS idx_attachments_wp      ON attachments(waypoint_id)       WHERE waypoint_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- F. Views
-- ---------------------------------------------------------------------------

CREATE VIEW IF NOT EXISTS v_trip_list AS
SELECT
  t.*,
  (SELECT COUNT(*) FROM waypoints      WHERE trip_id = t.id) AS waypoint_count,
  (SELECT COUNT(*) FROM journal_entries WHERE trip_id = t.id) AS journal_count,
  (SELECT COUNT(*) FROM attachments    WHERE trip_id = t.id) AS attachment_count,
  CASE WHEN t.short_code IS NOT NULL
    THEN 'https://ride.incitat.io/' || t.short_code
    ELSE NULL
  END AS short_url
FROM trips t;

CREATE VIEW IF NOT EXISTS v_trip_with_route AS
SELECT
  t.*,
  CASE WHEN t.short_code IS NOT NULL
    THEN 'https://ride.incitat.io/' || t.short_code
    ELSE NULL
  END AS short_url,
  rd.coordinates AS route_coordinates,
  rd.distance    AS route_distance,
  rd.duration    AS route_duration
FROM trips t
LEFT JOIN route_data rd ON rd.trip_id = t.id;

CREATE VIEW IF NOT EXISTS v_trip_public AS
SELECT
  t.id,
  t.short_code,
  COALESCE(t.public_title, t.name)                  AS title,
  COALESCE(t.public_description, t.description, '')  AS description,
  t.public_contact                                    AS contact,
  t.cover_image_url                                   AS cover_image,
  t.cover_focus_x,
  t.cover_focus_y,
  t.created_at,
  rd.coordinates AS route_coordinates,
  rd.distance    AS route_distance,
  rd.duration    AS route_duration
FROM trips t
LEFT JOIN route_data rd ON rd.trip_id = t.id
WHERE t.is_public = 1 AND t.short_code IS NOT NULL;

CREATE VIEW IF NOT EXISTS v_attachment AS
SELECT
  a.*,
  'https://ride.incitat.io/api/attachments/' || a.id AS url
FROM attachments a;

CREATE VIEW IF NOT EXISTS v_attachment_access AS
SELECT
  a.*,
  t.user_id   AS trip_owner_id,
  t.is_public AS trip_is_public,
  'https://ride.incitat.io/api/attachments/' || a.id AS url
FROM attachments a
JOIN trips t ON a.trip_id = t.id;
