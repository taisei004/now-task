CREATE TABLE discord_reminders (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 token_cipher TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1,
 last_sent INTEGER,
 last_error TEXT,
 last_test INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE discord_reminder_deliveries (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 slot TEXT NOT NULL,
 status TEXT NOT NULL,
 PRIMARY KEY(user_id,slot)
);
