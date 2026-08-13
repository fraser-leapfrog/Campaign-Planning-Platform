-- Leapfrog Campaign Board — D1 schema
-- Run once with: wrangler d1 execute leapfrog_campaigns --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Agreed',
  loc TEXT NOT NULL DEFAULT '[]',        -- JSON array, e.g. '["WMC","Swansea"]'
  deal TEXT,
  retarget TEXT,
  start_date TEXT,                        -- 'YYYY-MM-DD' or NULL
  end_date TEXT,
  notes TEXT,
  rotation TEXT,                           -- '1/6' | '1/18' | NULL
  deleted INTEGER NOT NULL DEFAULT 0,      -- 1 = archived
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaigns_deleted ON campaigns(deleted);

-- Marketing Planner — completely separate from the campaigns table above
-- (own tab, own data, seeded from the Notion "Marketing Calendar" board).
CREATE TABLE IF NOT EXISTS marketing_ideas (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  notes TEXT,                               -- freeform, for building on the idea over time
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS marketing_calendar (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  date TEXT NOT NULL,                      -- 'YYYY-MM-DD'
  end_date TEXT,
  type TEXT,                                -- e.g. 'Social Media', 'Email', 'Event' — from Notion, optional
  status TEXT,                              -- e.g. 'Idea', 'Planning', 'Live', 'Completed' — optional
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_marketing_calendar_date ON marketing_calendar(date);
