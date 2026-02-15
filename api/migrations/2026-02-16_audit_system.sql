-- 2026-02-16: Audit system + fix login_events missing columns
-- 1. Add missing columns to login_events (provider_id, client_hints)
-- 2. Add user status column for ban/suspend capability
-- 3. Add admin_notes table for audit trail

-- Fix login_events: add provider_id and client_hints columns
ALTER TABLE login_events ADD COLUMN provider_id TEXT;
ALTER TABLE login_events ADD COLUMN client_hints TEXT;

-- User moderation status: 'active' (default), 'suspended', 'banned'
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- Admin audit notes — internal only, never exposed to users
CREATE TABLE IF NOT EXISTS admin_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL, -- 'audit', 'suspend', 'ban', 'restore', 'note'
  content TEXT,         -- free-text note or auto-generated report
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_notes_user ON admin_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_notes_created ON admin_notes(created_at DESC);
