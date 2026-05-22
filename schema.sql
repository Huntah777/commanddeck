-- Madinah · Command Deck — D1 schema
-- Paste into Cloudflare dashboard: D1 → your database → Console
-- (or run via wrangler: wrangler d1 execute madinah-deck --remote --file=./schema.sql)

CREATE TABLE IF NOT EXISTS state (
  id          INTEGER PRIMARY KEY,
  data        TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL DEFAULT 0
);

-- Seed the single row so PUT can always UPSERT cleanly
INSERT OR IGNORE INTO state (id, data, updated_at) VALUES (1, '{}', 0);
