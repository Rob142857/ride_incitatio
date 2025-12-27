-- Add linked auth identities to support multiple SSO providers per user/email
-- Safe to run multiple times.

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

-- Backfill from existing users table (treat users.provider/provider_id as the first linked identity)
INSERT OR IGNORE INTO auth_identities (id, user_id, provider, provider_id, email, created_at, last_login)
SELECT
  lower(hex(randomblob(16))) AS id,
  id AS user_id,
  provider,
  provider_id,
  email,
  created_at,
  last_login
FROM users;
