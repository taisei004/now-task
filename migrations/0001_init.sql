CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oauth_states (hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE tasks (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,id));
CREATE INDEX tasks_user ON tasks(user_id,updated_at);
CREATE TABLE ai_cache (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, result TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE ai_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,day));
