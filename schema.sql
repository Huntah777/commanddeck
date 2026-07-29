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

-- `data` is the whole app state as one JSON blob, merged server-side on every
-- PUT (see functions/api/state.js). Two fields exist purely for that merge:
--   deleted  { [id]: deletedAt }                      — tombstones
--   logsOff  { 'YYYY-MM-DD': { [habitId]: at } }      — habit un-ticks
-- Both are needed because absence can't mean "deleted": a device that hasn't
-- heard about an item yet pushes a payload without it. Both are garbage-
-- collected after 90 days.
-- `updated_at` doubles as the ETag/optimistic-concurrency version, so it must
-- stay strictly increasing.

-- Web Push subscriptions + notification schedule (one row per device/browser)
CREATE TABLE IF NOT EXISTS push_subs (
  id           TEXT PRIMARY KEY,   -- last 32 chars of the push endpoint (stable device ID)
  subscription TEXT NOT NULL,      -- JSON: { endpoint, keys: { p256dh, auth } }
  schedule     TEXT NOT NULL DEFAULT '[]', -- JSON: today's FULL plan [{ id, title, body, fireAt }]
  sent         TEXT NOT NULL DEFAULT '[]', -- JSON: ids already delivered (or retired) for plan_day
  plan_day     TEXT NOT NULL DEFAULT '',   -- local day the plan/sent pair belongs to, 'YYYY-MM-DD'
  next_fire_at INTEGER NOT NULL DEFAULT 0, -- unix ms of earliest undelivered entry (0 = none)
  updated_at   INTEGER NOT NULL            -- last time this sub was confirmed WORKING (client POST or successful send)
);

-- `schedule` is rebuilt from scratch by the Cron Worker every tick and is never
-- consumed; what has actually gone out is tracked in `sent`, which resets when
-- `plan_day` rolls over. That split is what lets a delayed or skipped cron tick
-- still deliver, instead of silently dropping the notification.
--
-- GET /api/push?id=… reads this row back for the Alerts card. Push fails
-- silently by nature — the browser keeps reporting a healthy subscription long
-- after the row behind it is gone — so `updated_at` (last time this device was
-- confirmed WORKING) is the only way the app can tell "delivering fine" from
-- "dead for three weeks". See functions/api/push.js.

-- Migrations — run once each if the table predates these columns:
-- ALTER TABLE push_subs ADD COLUMN next_fire_at INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE push_subs ADD COLUMN sent     TEXT NOT NULL DEFAULT '[]';
-- ALTER TABLE push_subs ADD COLUMN plan_day TEXT NOT NULL DEFAULT '';
