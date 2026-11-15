// Website analytics tables, shared by the website Worker (writes) and The Pond (reads).
// A copy of this file lives in the website repo (Downloads/leapfrog-website/worker/analytics-schema.js): keep the two in step.
//
// Privacy: nothing is stored on the visitor's device. A visitor is a daily-rotating hash of
// salt + IP + browser, and the salt for each UK day is thrown away after two days, so visits
// can't be linked across days or back to a person. Raw IPs are never stored.

export const WEB_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS web_salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS web_sessions (
     id TEXT PRIMARY KEY, visitor TEXT NOT NULL, started_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
     landing TEXT, referrer TEXT, channel TEXT NOT NULL, source TEXT, medium TEXT, campaign TEXT,
     term TEXT, content TEXT, click_id TEXT, device TEXT, country TEXT,
     pages INTEGER NOT NULL DEFAULT 0, converted INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS web_sessions_visitor ON web_sessions (visitor, last_at)`,
  `CREATE INDEX IF NOT EXISTS web_sessions_started ON web_sessions (started_at)`,
  `CREATE TABLE IF NOT EXISTS web_pageviews (
     id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, path TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS web_pageviews_ts ON web_pageviews (ts)`,
  `CREATE TABLE IF NOT EXISTS web_conversions (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT, form TEXT NOT NULL,
     page TEXT, campaign_type TEXT, area TEXT, name TEXT, company TEXT, dedupe TEXT UNIQUE,
     channel TEXT, source TEXT, medium TEXT, campaign TEXT, landing TEXT, referrer TEXT, device TEXT)`,
  `CREATE INDEX IF NOT EXISTS web_conversions_ts ON web_conversions (ts)`,
];

export async function ensureWebSchema(db) {
  await db.batch(WEB_SCHEMA.map((s) => db.prepare(s)));
}
