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

-- Web Push subscriptions + notification schedule (one row per device/browser)
CREATE TABLE IF NOT EXISTS push_subs (
  id           TEXT PRIMARY KEY,   -- last 32 chars of the push endpoint (stable device ID)
  subscription TEXT NOT NULL,      -- JSON: { endpoint, keys: { p256dh, auth } }
  schedule     TEXT NOT NULL DEFAULT '[]', -- JSON: [{ id, title, body, fireAt }]
  updated_at   INTEGER NOT NULL
);
