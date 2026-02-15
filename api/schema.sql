-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  provider TEXT NOT NULL, -- 'google', 'facebook', 'microsoft'
  provider_id TEXT NOT NULL,
  last_login TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(provider, provider_id)
);

-- Linked identities (allow multiple SSO providers per email/user)
CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  email TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT,
  UNIQUE(provider, provider_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user ON auth_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_identities_provider ON auth_identities(provider, provider_id);

-- Short URLs table (for ultra-short sharing links)
CREATE TABLE IF NOT EXISTS short_urls (
  code TEXT PRIMARY KEY, -- 6-char base62 code
  trip_id TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

-- Trips table
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  settings TEXT, -- JSON blob for trip settings
  share_id TEXT UNIQUE,
  short_code TEXT UNIQUE, -- 6-char short URL code
  is_public INTEGER DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  -- Public display settings (no personal info)
  public_title TEXT, -- Custom title for public view
  public_description TEXT, -- Description for public view
  public_contact TEXT, -- Optional contact info
  cover_image_url TEXT, -- Hero image for social sharing
  cover_focus_x INTEGER NOT NULL DEFAULT 50, -- Background-position X (0-100%)
  cover_focus_y INTEGER NOT NULL DEFAULT 50, -- Background-position Y (0-100%)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Waypoints table
CREATE TABLE IF NOT EXISTS waypoints (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  type TEXT DEFAULT 'stop',
  notes TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

-- Journal entries table
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  waypoint_id TEXT,
  title TEXT NOT NULL,
  content TEXT,
  is_private INTEGER DEFAULT 0,
  tags TEXT, -- JSON array
  location TEXT, -- JSON {lat, lng}
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  FOREIGN KEY (waypoint_id) REFERENCES waypoints(id) ON DELETE SET NULL
);

-- Attachments table (images, documents)
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  journal_entry_id TEXT, -- Optional: attach to specific journal entry
  waypoint_id TEXT, -- Optional: attach to specific waypoint
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key TEXT NOT NULL, -- R2 object key
  is_private INTEGER DEFAULT 0,
  is_cover INTEGER DEFAULT 0, -- Use as trip cover image
  caption TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (waypoint_id) REFERENCES waypoints(id) ON DELETE SET NULL
);

-- Enforce attachments stay within the same trip for journal entries and waypoints
CREATE TRIGGER IF NOT EXISTS trg_attachments_journal_trip_insert
BEFORE INSERT ON attachments
WHEN NEW.journal_entry_id IS NOT NULL AND (
  SELECT trip_id FROM journal_entries WHERE id = NEW.journal_entry_id
) IS NOT NEW.trip_id
BEGIN
  SELECT RAISE(ABORT, 'journal_entry_id does not belong to trip');
END;

CREATE TRIGGER IF NOT EXISTS trg_attachments_journal_trip_update
BEFORE UPDATE ON attachments
WHEN NEW.journal_entry_id IS NOT NULL AND (
  SELECT trip_id FROM journal_entries WHERE id = NEW.journal_entry_id
) IS NOT NEW.trip_id
BEGIN
  SELECT RAISE(ABORT, 'journal_entry_id does not belong to trip');
END;

CREATE TRIGGER IF NOT EXISTS trg_attachments_waypoint_trip_insert
BEFORE INSERT ON attachments
WHEN NEW.waypoint_id IS NOT NULL AND (
  SELECT trip_id FROM waypoints WHERE id = NEW.waypoint_id
) IS NOT NEW.trip_id
BEGIN
  SELECT RAISE(ABORT, 'waypoint_id does not belong to trip');
END;

CREATE TRIGGER IF NOT EXISTS trg_attachments_waypoint_trip_update
BEFORE UPDATE ON attachments
WHEN NEW.waypoint_id IS NOT NULL AND (
  SELECT trip_id FROM waypoints WHERE id = NEW.waypoint_id
) IS NOT NEW.trip_id
BEGIN
  SELECT RAISE(ABORT, 'waypoint_id does not belong to trip');
END;

-- Route data table (for custom route points)
CREATE TABLE IF NOT EXISTS route_data (
  id TEXT PRIMARY KEY,
  trip_id TEXT UNIQUE NOT NULL,
  coordinates TEXT, -- JSON array of {lat, lng}
  distance REAL,
  duration REAL,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);
CREATE INDEX IF NOT EXISTS idx_trips_share ON trips(share_id);
CREATE INDEX IF NOT EXISTS idx_trips_short ON trips(short_code);
CREATE INDEX IF NOT EXISTS idx_short_urls_code ON short_urls(code);
CREATE INDEX IF NOT EXISTS idx_waypoints_trip ON waypoints(trip_id);
CREATE INDEX IF NOT EXISTS idx_journal_trip ON journal_entries(trip_id);
CREATE INDEX IF NOT EXISTS idx_attachments_trip ON attachments(trip_id);
CREATE INDEX IF NOT EXISTS idx_attachments_journal ON attachments(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_attachments_waypoint ON attachments(waypoint_id);

-- Login audit table (lightweight)
CREATE TABLE IF NOT EXISTS login_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT,
  provider TEXT,
  provider_id TEXT,
  ip TEXT,
  user_agent TEXT,
  client_hints TEXT, -- JSON blob for device hints (sec-ch-ua*, cf headers)
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id);
