-- =============================================================================
-- Ride Trip Planner — D1 Schema v2
-- =============================================================================
-- Design principle: push all validation, consistency, and auto-maintenance
-- into the database.  Application code becomes a thin pass-through.
--
-- What the DB now enforces (so app code no longer needs to):
--   • updated_at auto-set on every UPDATE (triggers)
--   • trips.version auto-bumped on any trip or child-table mutation (triggers)
--   • lat/lng range validation (CHECK)
--   • enum values for provider, waypoint type, boolean integers (CHECK)
--   • email lowercase normalisation (trigger)
--   • string length limits (CHECK)
--   • referential integrity with proper CASCADE/SET NULL (FK)
--   • attachment scoping to same trip as parent journal/waypoint (triggers)
--   • single cover image per trip (trigger)
--   • short_code format (CHECK)
--
-- Views provide pre-composed reads so handlers are one-liners.
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------------------
-- 1. USERS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY CHECK(length(id) > 0 AND length(id) <= 64),
  email         TEXT NOT NULL CHECK(email LIKE '%_@_%._%' AND length(email) <= 320),
  name          TEXT CHECK(length(name) <= 200),
  avatar_url    TEXT CHECK(length(avatar_url) <= 2048),
  provider      TEXT NOT NULL CHECK(provider IN ('google','facebook','microsoft','apple')),
  provider_id   TEXT NOT NULL CHECK(length(provider_id) > 0 AND length(provider_id) <= 256),
  last_login    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(email),
  UNIQUE(provider, provider_id)
);

-- Auto-update updated_at on any user modification
CREATE TRIGGER IF NOT EXISTS trg_users_updated
AFTER UPDATE ON users
FOR EACH ROW
BEGIN
  UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Normalise email to lowercase on insert
CREATE TRIGGER IF NOT EXISTS trg_users_email_lower_insert
BEFORE INSERT ON users
WHEN NEW.email != lower(NEW.email)
BEGIN
  SELECT RAISE(ABORT, 'email must be lowercase');
END;

-- Normalise email to lowercase on update
CREATE TRIGGER IF NOT EXISTS trg_users_email_lower_update
BEFORE UPDATE OF email ON users
WHEN NEW.email != lower(NEW.email)
BEGIN
  SELECT RAISE(ABORT, 'email must be lowercase');
END;

-- ---------------------------------------------------------------------------
-- 2. AUTH IDENTITIES (multi-provider linking)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_identities (
  id            TEXT PRIMARY KEY CHECK(length(id) > 0),
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK(provider IN ('google','facebook','microsoft','apple')),
  provider_id   TEXT NOT NULL CHECK(length(provider_id) > 0 AND length(provider_id) <= 256),
  email         TEXT CHECK(email IS NULL OR (email LIKE '%_@_%._%' AND length(email) <= 320)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login    TEXT,
  UNIQUE(provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_identities_lookup ON auth_identities(provider, provider_id);

-- ---------------------------------------------------------------------------
-- 3. TRIPS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
  id                  TEXT PRIMARY KEY CHECK(length(id) > 0 AND length(id) <= 64),
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL CHECK(length(name) >= 1 AND length(name) <= 500),
  description         TEXT DEFAULT '' CHECK(length(description) <= 5000),
  settings            TEXT DEFAULT '{}',  -- JSON blob
  short_code          TEXT UNIQUE CHECK(short_code IS NULL OR (length(short_code) = 6 AND short_code GLOB '[0-9a-zA-Z][0-9a-zA-Z][0-9a-zA-Z][0-9a-zA-Z][0-9a-zA-Z][0-9a-zA-Z]')),
  is_public           INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0, 1)),
  version             INTEGER NOT NULL DEFAULT 0,
  -- Public-facing display fields
  public_title        TEXT CHECK(public_title IS NULL OR length(public_title) <= 500),
  public_description  TEXT CHECK(public_description IS NULL OR length(public_description) <= 5000),
  public_contact      TEXT CHECK(public_contact IS NULL OR length(public_contact) <= 500),
  cover_image_url     TEXT CHECK(cover_image_url IS NULL OR length(cover_image_url) <= 2048),
  cover_focus_x       INTEGER NOT NULL DEFAULT 50 CHECK(cover_focus_x BETWEEN 0 AND 100),
  cover_focus_y       INTEGER NOT NULL DEFAULT 50 CHECK(cover_focus_y BETWEEN 0 AND 100),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trips_user       ON trips(user_id);
CREATE INDEX IF NOT EXISTS idx_trips_short_code ON trips(short_code) WHERE short_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trips_public     ON trips(is_public)  WHERE is_public = 1;

-- ---- Trip auto-maintenance triggers ----

-- Auto-update updated_at + bump version on any direct trip UPDATE
CREATE TRIGGER IF NOT EXISTS trg_trips_updated
AFTER UPDATE ON trips
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at  -- prevent infinite recursion
BEGIN
  UPDATE trips
  SET updated_at = datetime('now'),
      version    = version + 1
  WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- 4. WAYPOINTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waypoints (
  id          TEXT PRIMARY KEY CHECK(length(id) > 0 AND length(id) <= 64),
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK(length(name) >= 1 AND length(name) <= 500),
  address     TEXT DEFAULT '' CHECK(length(address) <= 1000),
  lat         REAL NOT NULL CHECK(lat BETWEEN -90 AND 90),
  lng         REAL NOT NULL CHECK(lng BETWEEN -180 AND 180),
  type        TEXT NOT NULL DEFAULT 'stop' CHECK(type IN ('stop','scenic','fuel','food','lodging','custom')),
  notes       TEXT DEFAULT '' CHECK(length(notes) <= 5000),
  sort_order  INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_waypoints_trip  ON waypoints(trip_id, sort_order);

-- Bump parent trip version when waypoints change
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

-- ---------------------------------------------------------------------------
-- 5. JOURNAL ENTRIES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_entries (
  id            TEXT PRIMARY KEY CHECK(length(id) > 0 AND length(id) <= 64),
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  waypoint_id   TEXT REFERENCES waypoints(id) ON DELETE SET NULL,
  title         TEXT NOT NULL CHECK(length(title) >= 1 AND length(title) <= 500),
  content       TEXT DEFAULT '' CHECK(length(content) <= 50000),
  is_private    INTEGER NOT NULL DEFAULT 0 CHECK(is_private IN (0, 1)),
  tags          TEXT DEFAULT '[]',   -- JSON array
  location      TEXT,                -- JSON {lat, lng} or null
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_journal_trip ON journal_entries(trip_id, created_at DESC);

-- Auto-update updated_at
CREATE TRIGGER IF NOT EXISTS trg_journal_updated
AFTER UPDATE ON journal_entries
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE journal_entries SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Bump parent trip version
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

-- ---------------------------------------------------------------------------
-- 6. ATTACHMENTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id                TEXT PRIMARY KEY CHECK(length(id) > 0 AND length(id) <= 64),
  trip_id           TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  journal_entry_id  TEXT REFERENCES journal_entries(id) ON DELETE SET NULL,
  waypoint_id       TEXT REFERENCES waypoints(id) ON DELETE SET NULL,
  filename          TEXT NOT NULL CHECK(length(filename) > 0 AND length(filename) <= 500),
  original_name     TEXT NOT NULL CHECK(length(original_name) > 0 AND length(original_name) <= 500),
  mime_type         TEXT NOT NULL CHECK(length(mime_type) > 0 AND length(mime_type) <= 200),
  size_bytes        INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 104857600),  -- max 100MB
  storage_key       TEXT NOT NULL CHECK(length(storage_key) > 0 AND length(storage_key) <= 1024),
  is_private        INTEGER NOT NULL DEFAULT 0 CHECK(is_private IN (0, 1)),
  is_cover          INTEGER NOT NULL DEFAULT 0 CHECK(is_cover IN (0, 1)),
  caption           TEXT DEFAULT '' CHECK(length(caption) <= 2000),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attachments_trip    ON attachments(trip_id);
CREATE INDEX IF NOT EXISTS idx_attachments_journal ON attachments(journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_wp      ON attachments(waypoint_id)       WHERE waypoint_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_cover   ON attachments(trip_id, is_cover) WHERE is_cover = 1;

-- Enforce: journal_entry must belong to same trip
CREATE TRIGGER IF NOT EXISTS trg_attachment_journal_scope_insert
BEFORE INSERT ON attachments
WHEN NEW.journal_entry_id IS NOT NULL
  AND (SELECT trip_id FROM journal_entries WHERE id = NEW.journal_entry_id) IS NOT NEW.trip_id
BEGIN
  SELECT RAISE(ABORT, 'SCOPE_VIOLATION: journal_entry does not belong to this trip');
END;

CREATE TRIGGER IF NOT EXISTS trg_attachment_journal_scope_update
BEFORE UPDATE OF journal_entry_id ON attachments
WHEN NEW.journal_entry_id IS NOT NULL
  AND (SELECT trip_id FROM journal_entries WHERE id = NEW.journal_entry_id) IS NOT NEW.trip_id
BEGIN
  SELECT RAISE(ABORT, 'SCOPE_VIOLATION: journal_entry does not belong to this trip');
END;

-- Enforce: waypoint must belong to same trip
CREATE TRIGGER IF NOT EXISTS trg_attachment_waypoint_scope_insert
BEFORE INSERT ON attachments
WHEN NEW.waypoint_id IS NOT NULL
  AND (SELECT trip_id FROM waypoints WHERE id = NEW.waypoint_id) IS NOT NEW.trip_id
BEGIN
  SELECT RAISE(ABORT, 'SCOPE_VIOLATION: waypoint does not belong to this trip');
END;

CREATE TRIGGER IF NOT EXISTS trg_attachment_waypoint_scope_update
BEFORE UPDATE OF waypoint_id ON attachments
WHEN NEW.waypoint_id IS NOT NULL
  AND (SELECT trip_id FROM waypoints WHERE id = NEW.waypoint_id) IS NOT NEW.trip_id
BEGIN
  SELECT RAISE(ABORT, 'SCOPE_VIOLATION: waypoint does not belong to this trip');
END;

-- Auto-clear other covers when a new cover is set
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

-- When cover is deleted, recompute cover_image_url
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

-- Bump parent trip version
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

-- ---------------------------------------------------------------------------
-- 7. ROUTE DATA
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_data (
  id          TEXT PRIMARY KEY CHECK(length(id) > 0),
  trip_id     TEXT NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  coordinates TEXT DEFAULT '[]',    -- JSON array of {lat, lng}
  distance    REAL CHECK(distance IS NULL OR distance >= 0),
  duration    REAL CHECK(duration IS NULL OR duration >= 0),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Auto-update updated_at
CREATE TRIGGER IF NOT EXISTS trg_route_data_updated
AFTER UPDATE ON route_data
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
  UPDATE route_data SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Bump parent trip version on route change
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
-- 8. LOGIN EVENTS (audit log)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_events (
  id            TEXT PRIMARY KEY CHECK(length(id) > 0),
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT CHECK(email IS NULL OR email LIKE '%_@_%._%'),
  provider      TEXT CHECK(provider IN ('google','facebook','microsoft','apple')),
  provider_id   TEXT,
  ip            TEXT DEFAULT 'unknown' CHECK(length(ip) <= 45),  -- max IPv6 length
  user_agent    TEXT DEFAULT '' CHECK(length(user_agent) <= 1000),
  client_hints  TEXT DEFAULT '{}',  -- JSON
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_user    ON login_events(user_id);

-- ---------------------------------------------------------------------------
-- 9. VIEWS — pre-composed reads for thin handler code
-- ---------------------------------------------------------------------------

-- Trip list for a user (with counts) — replaces inline subquery SELECTs
CREATE VIEW IF NOT EXISTS v_trip_list AS
SELECT
  t.*,
  (SELECT COUNT(*) FROM waypoints   WHERE trip_id = t.id) AS waypoint_count,
  (SELECT COUNT(*) FROM journal_entries WHERE trip_id = t.id) AS journal_count,
  (SELECT COUNT(*) FROM attachments WHERE trip_id = t.id) AS attachment_count,
  CASE WHEN t.short_code IS NOT NULL
    THEN 'https://ride.incitat.io/' || t.short_code
    ELSE NULL
  END AS short_url
FROM trips t;

-- Full trip with route (single trip load)
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

-- Public trip view — ONLY safe-to-expose columns, no user_id
CREATE VIEW IF NOT EXISTS v_trip_public AS
SELECT
  t.short_code,
  COALESCE(t.public_title, t.name)        AS title,
  COALESCE(t.public_description, t.description, '') AS description,
  t.public_contact                         AS contact,
  t.cover_image_url                        AS cover_image,
  t.cover_focus_x,
  t.cover_focus_y,
  t.created_at,
  rd.coordinates AS route_coordinates,
  rd.distance    AS route_distance,
  rd.duration    AS route_duration
FROM trips t
LEFT JOIN route_data rd ON rd.trip_id = t.id
WHERE t.is_public = 1 AND t.short_code IS NOT NULL;

-- Attachment with download URL pre-computed
CREATE VIEW IF NOT EXISTS v_attachment AS
SELECT
  a.*,
  'https://ride.incitat.io/api/attachments/' || a.id AS url
FROM attachments a;

-- Attachment access check (for serving files) — joins trip for ownership + public check
CREATE VIEW IF NOT EXISTS v_attachment_access AS
SELECT
  a.*,
  t.user_id       AS trip_owner_id,
  t.is_public     AS trip_is_public,
  'https://ride.incitat.io/api/attachments/' || a.id AS url
FROM attachments a
JOIN trips t ON a.trip_id = t.id;

-- ---------------------------------------------------------------------------
-- NOTES
-- ---------------------------------------------------------------------------
-- Removed: short_urls table (dead — short_code lives on trips directly)
-- Removed: share_id column (unused — replaced by short_code)
--
-- What triggers buy us (code we can DELETE from api/trips.js):
--   • bumpTripVersion() — entire function eliminated
--   • manual 'updated_at = datetime("now")' in every UPDATE — eliminated
--   • manual 'version = version + 1' in every UPDATE — eliminated
--   • manual cover image unsetting on new cover — eliminated
--   • manual cover image recompute on delete — eliminated
--   • manual journal/waypoint trip-scope validation in uploadAttachment — eliminated
--
-- What CHECK constraints buy us (validation code we can DELETE):
--   • lat/lng range checks in addWaypoint, updateWaypoint
--   • name-required checks (DB will reject empty)
--   • short_code format validation in worker.js
--   • boolean normalisation for is_public, is_private, is_cover
-- ---------------------------------------------------------------------------
