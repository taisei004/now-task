CREATE TABLE notion_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_cipher TEXT NOT NULL,
  root_page_id TEXT NOT NULL,
  task_source_id TEXT NOT NULL,
  project_source_id TEXT NOT NULL,
  summary_page_id TEXT NOT NULL,
  summary_block_id TEXT NOT NULL,
  summary_hash TEXT,
  last_sync INTEGER,
  last_error TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT
);
CREATE TABLE notion_task_links (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  shadow TEXT NOT NULL,
  conflict TEXT,
  resolution TEXT CHECK (resolution IN ('now','notion')),
  PRIMARY KEY(user_id,task_id),
  UNIQUE(user_id,page_id)
);
