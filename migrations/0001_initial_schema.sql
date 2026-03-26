CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('proxy', 'site', 'redirect', 'text')),
  target_url TEXT,
  content TEXT,
  user_agent TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  strip_cookies INTEGER NOT NULL DEFAULT 1 CHECK (strip_cookies IN (0, 1)),
  enable_cors INTEGER NOT NULL DEFAULT 0 CHECK (enable_cors IN (0, 1)),
  block_private_targets INTEGER NOT NULL DEFAULT 1 CHECK (block_private_targets IN (0, 1)),
  rewrite_html INTEGER NOT NULL DEFAULT 0 CHECK (rewrite_html IN (0, 1)),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_routes_enabled ON routes(enabled);
CREATE INDEX IF NOT EXISTS idx_routes_kind_enabled ON routes(kind, enabled);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO system_settings(key, value)
VALUES ('session_revision', '0')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_updated_at ON login_attempts(updated_at);
