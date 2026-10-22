PRAGMA foreign_keys = ON;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  manager_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE connection_tickets (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  manager_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX connection_tickets_expiry ON connection_tickets(expires_at);

CREATE TABLE manager_grants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  manager_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX manager_grants_session ON manager_grants(session_id);

CREATE TABLE download_tickets (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  manager_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX download_tickets_expiry ON download_tickets(expires_at);

CREATE TABLE login_rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
