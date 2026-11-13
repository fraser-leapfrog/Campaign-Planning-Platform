// Notifications: the bell in the top bar.
//
// Each rule writes a row to `notifications` with a unique `key`, so a notification is only ever
// created once. Read/unread is per person (Cloudflare Access email) in `notification_reads`.
//
//   Campaign rules (cheap, database only; run on every GET /api/notifications and on the schedule)
//     new-report      a finished Campaign Board campaign became a Billboard report to-do
//     live-tomorrow   a booking starts tomorrow
//     proofs          a booking starts today: "Do the proofs"
//     ending          a booking's last day is tomorrow
//     artwork         starts within 3 days but still Awaiting Artwork / Awaiting Approval
//     hold            on "To Hold" for 7+ days
//     overbooked      confirmed bookings exceed a venue's slots on an upcoming day
//     overdue         a report is still to-do 7 days after its campaign ended
//   Checks that call Navori/Datajam (run by the 15-minute schedule, see wrangler.toml)
//     screen-offline / screen-online   a Navori player hasn't checked in for 2+ hours
//     jambox-offline / jambox-online   a JamBox is Disabled or not seen for 24+ hours
//     underdelivery   once each morning: a live report behind its agreed 1/6 or 1/18 pace

import { json, requireAccess } from "./utils.js";
import {
  ensureSchema as ensureBillboardSchema, syncFromBoard, Navori, datajamGet, fetchCampaignData, todayLondon, addDays,
  daysBetween, campaignFromRow, screenFromRow,
} from "./billboard.js";

// Keep in step with LOCATIONS in public/index.html (the board's venue capacities).
const CAPACITY = { "WMC": 9, "Quadrant Shopping Centre": 18, "Parc Tawe Retail Park": 18 };
const HOLD_DAYS = 7;
const OVERDUE_DAYS = 7;
const ARTWORK_DAYS = 3;
const SCREEN_OFFLINE_HOURS = 2;
const JAMBOX_OFFLINE_HOURS = 24;
const UNDERDELIVERY_HOUR = 8;      // UK hour after which the daily under-delivery check runs
const UNDERDELIVERY_REPEAT = 3;    // remind at most every 3 days while a campaign is behind
const KEEP_DAYS = 45;              // how far back the bell shows

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notifications (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     key TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     link_type TEXT,          -- 'board' | 'report' | 'screens' | NULL
     link_id TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS notification_reads (
     notification_id INTEGER NOT NULL,
     user_email TEXT NOT NULL,
     read_at TEXT NOT NULL,
     PRIMARY KEY (notification_id, user_email)
   )`,
  // Small key/value store: when holds started, open screen/JamBox incidents, last check times.
  `CREATE TABLE IF NOT EXISTS notification_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  await ensureBillboardSchema(env);
  schemaReady = true;
}

// ----------------------------------------------------------------------------- helpers
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const nice = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };
const londonHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" })
  .format(new Date()));
const stripIndex = (name) => String(name || "").replace(/\s*-?\s*\(?\d+\)?$/, "").trim();   // same as the board

function notify(env, n) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO notifications (key, kind, title, body, link_type, link_id, created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(n.key, n.kind, n.title, n.body || "", n.link_type || null, n.link_id == null ? null : String(n.link_id),
      new Date().toISOString());
}

async function getState(env, key) {
  const r = await env.DB.prepare("SELECT value FROM notification_state WHERE key = ?").bind(key).first();
  return r ? r.value : null;
}
function setState(env, key, value) {
  return env.DB.prepare(`INSERT INTO notification_state (key, value, updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, value, new Date().toISOString());
}

// Board rows -> bookings, grouped the way the board groups them (a 1/6 booking is 3 rows).
function groupBoard(rows) {
  const groups = new Map();
  for (const r of rows) {
    let loc = [];
    try { loc = JSON.parse(r.loc || "[]"); } catch (_) { /* no venues */ }
    const name = stripIndex(r.name);
    const key = [name, r.start_date, r.end_date, r.status, r.deal, r.retarget, r.rotation, [...loc].sort().join(",")].join("|");
    if (!groups.has(key)) groups.set(key, { name, status: r.status, start: r.start_date, end: r.end_date, loc, rotation: r.rotation, ids: [], updated: [] });
    const g = groups.get(key);
    g.ids.push(r.id);
    g.updated.push(r.updated_at || "");
  }
  for (const g of groups.values()) {
    g.ids.sort();
    g.id = g.ids[0];
    g.slots = g.ids.length;
    g.rotation = g.rotation || (g.slots >= 3 ? "1/6" : "1/18");
  }
  return [...groups.values()];
}

const venues = (g) => g.loc.join(", ") || "no venue set";

// ----------------------------------------------------------------------------- campaign rules
export async function runCampaignRules(env) {
  await ensureSchema(env);
  try { await syncFromBoard(env); } catch (e) { console.error("notifications: board sync failed", e); }
  const today = todayLondon();
  const tomorrow = addDays(today, 1);
  const stmts = [];

  const { results: rows } = await env.DB.prepare(
    `SELECT id, name, status, loc, deal, retarget, rotation, start_date, end_date, updated_at
     FROM campaigns WHERE deleted = 0`).all();
  const groups = groupBoard(rows);
  const running = (g) => g.status !== "To Hold";

  for (const g of groups) {
    const link = { link_type: "board", link_id: g.id };
    if (g.start === tomorrow && running(g)) {
      stmts.push(notify(env, { key: `live-tomorrow:${g.id}:${g.start}`, kind: "live-tomorrow", ...link,
        title: `Goes live tomorrow: ${g.name}`, body: `${venues(g)} · ${g.rotation} · runs to ${nice(g.end || g.start)}` }));
    }
    if (g.start === today && running(g)) {
      stmts.push(notify(env, { key: `proofs:${g.id}:${g.start}`, kind: "proofs", ...link,
        title: `Do the proofs: ${g.name}`, body: `Live today at ${venues(g)}.` }));
    }
    if (g.end === tomorrow && running(g)) {
      stmts.push(notify(env, { key: `ending:${g.id}:${g.end}`, kind: "ending", ...link,
        title: `Ends tomorrow: ${g.name}`, body: `Last day is ${nice(g.end)} at ${venues(g)}. Take it off the screens afterwards.` }));
    }
    if (["Awaiting Artwork", "Awaiting Approval"].includes(g.status) && g.start && g.start >= today
      && daysBetween(today, g.start) <= ARTWORK_DAYS) {
      const n = daysBetween(today, g.start);
      stmts.push(notify(env, { key: `artwork:${g.id}:${g.start}`, kind: "artwork", ...link,
        title: `Artwork still missing: ${g.name}`,
        body: `Starts ${n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`} (${nice(g.start)}) and is still "${g.status}".` }));
    }
  }

  // On hold for 7+ days. Hold start is remembered the first time we see it on hold (its last edit
  // time is the best guess for holds that existed before notifications did).
  const holdKeys = new Set();
  for (const g of groups.filter((x) => x.status === "To Hold")) {
    const sk = `hold-since:${g.id}`;
    holdKeys.add(sk);
    let since = await getState(env, sk);
    if (!since) {
      since = (g.updated.sort()[0] || today).slice(0, 10);
      stmts.push(setState(env, sk, since));
    }
    const days = daysBetween(since, today);
    if (days >= HOLD_DAYS) {
      stmts.push(notify(env, { key: `hold:${g.id}:${since}`, kind: "hold", link_type: "board", link_id: g.id,
        title: `On hold ${days}+ days: ${g.name}`, body: `"To Hold" since ${nice(since)}${g.start ? ` · ${nice(g.start)}–${nice(g.end || g.start)}` : ""}. Confirm or release it.` }));
    }
  }
  // Forget holds that are no longer on hold, so a future hold starts a fresh 7-day clock.
  const { results: holdState } = await env.DB.prepare("SELECT key FROM notification_state WHERE key LIKE 'hold-since:%'").all();
  for (const r of holdState) if (!holdKeys.has(r.key)) stmts.push(env.DB.prepare("DELETE FROM notification_state WHERE key = ?").bind(r.key));

  // Venue overbooked: confirmed (not "To Hold") slots above capacity on any day, from 60 days back
  // (so a run that started earlier keeps the same key) to 90 days ahead.
  for (const [venue, cap] of Object.entries(CAPACITY)) {
    const vg = groups.filter((g) => g.loc.includes(venue) && (g.start || g.end));
    let run = null;
    const flush = () => {
      if (run && run.end >= today) {
        stmts.push(notify(env, { key: `overbooked:${venue}:${run.start}`, kind: "overbooked", link_type: "board", link_id: null,
          title: `Overbooked: ${venue}`,
          body: `${run.max} of ${cap} slots booked${run.start === run.end ? ` on ${nice(run.start)}` : ` between ${nice(run.start)} and ${nice(run.end)}`}${run.hold ? ` (plus ${run.hold} on hold)` : ""}.` }));
      }
      run = null;
    };
    for (let d = addDays(today, -60); d <= addDays(today, 90); d = addDays(d, 1)) {
      let confirmed = 0, hold = 0;
      for (const g of vg) {
        if (g.end && g.end < d) continue;
        if (g.start && g.start > d) continue;
        if (g.status === "To Hold") hold += g.slots; else confirmed += g.slots;
      }
      if (confirmed > cap) {
        if (!run) run = { start: d, end: d, max: confirmed, hold };
        run.end = d;
        run.max = Math.max(run.max, confirmed);
        run.hold = Math.max(run.hold, hold);
      } else flush();
    }
    flush();
  }

  // Billboard report to-dos: new ones from the board, and overdue ones.
  const { results: reports } = await env.DB.prepare(
    "SELECT * FROM billboard_campaigns WHERE report_status != 'completed'").all();
  for (const r of reports.map(campaignFromRow)) {
    const link = { link_type: "report", link_id: r.id };
    if (r.from_board) {
      stmts.push(notify(env, { key: `new-report:${r.id}`, kind: "new-report", ...link,
        title: `New report to do: ${r.client_name}`, body: `Campaign finished ${nice(r.end_date)}. Tick the artworks, then fetch the numbers.` }));
    }
    const late = daysBetween(r.end_date, today);
    if (late >= OVERDUE_DAYS) {
      stmts.push(notify(env, { key: `overdue:${r.id}`, kind: "overdue", ...link,
        title: `Report overdue: ${r.client_name}`, body: `Campaign ended ${nice(r.end_date)}, ${late} days ago.` }));
    }
  }

  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

// ----------------------------------------------------------------------------- screen / JamBox checks
// Navori's LastNotify has no time zone. Work out the offset from the freshest player (healthy
// players check in every few minutes), so the 2-hour rule works in GMT and BST alike.
function parseNavoriTime(s) {
  const t = Date.parse(`${String(s || "").slice(0, 19)}Z`);
  return Number.isFinite(t) ? t : null;
}

async function checkScreens(env) {
  const players = (await new Navori(env).players()).filter((p) => p.Active);
  const times = players.map((p) => parseNavoriTime(p.LastNotify)).filter((t) => t !== null);
  if (!times.length) return;
  const now = Date.now();
  const freshest = Math.max(...times);
  const offsetH = Math.abs(now - freshest) < 3 * 3600e3 ? Math.round((now - freshest) / 3600e3) : 0;
  const stmts = [];
  for (const p of players) {
    const t = parseNavoriTime(p.LastNotify);
    const seen = t === null ? null : t + offsetH * 3600e3;
    const offline = seen === null || now - seen > SCREEN_OFFLINE_HOURS * 3600e3;
    const sk = `screen-offline:${p.Id}`;
    const open = await getState(env, sk);
    if (offline && !open) {
      const since = seen ? new Date(seen).toISOString() : new Date(now).toISOString();
      stmts.push(setState(env, sk, since));
      const when = seen ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(seen)) : "never";
      stmts.push(notify(env, { key: `screen-offline:${p.Id}:${since}`, kind: "screen-offline", link_type: "screens",
        title: `Screen offline: ${p.Name}`, body: `No check-in from its Navori player since ${when}.` }));
    } else if (!offline && open) {
      stmts.push(env.DB.prepare("DELETE FROM notification_state WHERE key = ?").bind(sk));
      stmts.push(notify(env, { key: `screen-online:${p.Id}:${open}`, kind: "screen-online", link_type: "screens",
        title: `Screen back online: ${p.Name}`, body: "Its Navori player is checking in again." }));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

async function checkJamBoxes(env) {
  // Only the JamBoxes our screens use.
  const { results: screens } = await env.DB.prepare(
    "SELECT name, datajam_project, datajam_device FROM billboard_screens WHERE active = 1 AND datajam_device IS NOT NULL").all();
  const byDevice = new Map();
  for (const s of screens) {
    if (!byDevice.has(s.datajam_device)) byDevice.set(s.datajam_device, { project: s.datajam_project, screens: [] });
    byDevice.get(s.datajam_device).screens.push(s.name);
  }
  const projects = [...new Set([...byDevice.values()].map((d) => d.project))];
  const now = Date.now();
  const stmts = [];
  for (const project of projects) {
    const info = await datajamGet(env, "GetDeviceInfo", { project_name: project });
    for (const d of (info && info.device_info) || []) {
      const mine = byDevice.get(d.device_number);
      if (!mine) continue;
      const seen = d.last_seen ? Date.parse(d.last_seen) : null;
      const disabled = d.registration_status === "Disabled";
      const quiet = !seen || now - seen > JAMBOX_OFFLINE_HOURS * 3600e3;
      const offline = disabled || quiet;
      const sk = `jambox-offline:${d.device_number}`;
      const open = await getState(env, sk);
      if (offline && !open) {
        const since = new Date(seen || now).toISOString();
        stmts.push(setState(env, sk, since));
        stmts.push(notify(env, { key: `jambox-offline:${d.device_number}:${since}`, kind: "jambox-offline", link_type: "screens",
          title: `JamBox offline: ${d.device_number}`,
          body: `${disabled ? "Datajam has disabled it" : "Not seen for 24+ hours"} (${mine.screens.join(", ")}). Footfall will be missing. Email devteam@data-jam.com to re-enable it.` }));
      } else if (!offline && open) {
        stmts.push(env.DB.prepare("DELETE FROM notification_state WHERE key = ?").bind(sk));
        stmts.push(notify(env, { key: `jambox-online:${d.device_number}:${open}`, kind: "jambox-online", link_type: "screens",
          title: `JamBox back online: ${d.device_number}`, body: `Counting again (${mine.screens.join(", ")}).` }));
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// Once a morning: reports that are live, have artworks and a package, and are behind the agreed pace.
async function checkUnderdelivery(env) {
  const today = todayLondon();
  if (londonHour() < UNDERDELIVERY_HOUR || (await getState(env, "underdelivery-last-run")) === today) return;
  await setState(env, "underdelivery-last-run", today).run();
  const yesterday = addDays(today, -1);
  const { results } = await env.DB.prepare(
    `SELECT * FROM billboard_campaigns WHERE start_date <= ? AND end_date >= ? AND share_of_voice != '' AND artworks != '[]'`)
    .bind(yesterday, yesterday).all();
  for (const c of results.map(campaignFromRow)) {
    try {
      const ids = c.screen_ids;
      if (!ids.length) continue;
      const { results: rows } = await env.DB.prepare(
        `SELECT * FROM billboard_screens WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
      const screens = rows.map(screenFromRow);
      const key = c.share_of_voice === "1/6" ? "agreed_week_1_6" : "agreed_week_1_18";
      const rated = screens.filter((s) => s[key]);
      if (!rated.length) continue;
      const data = await fetchCampaignData(env, { ...c, include_footfall: false }, rated, yesterday);
      const days = daysBetween(c.start_date, yesterday) + 1;
      const agreed = rated.reduce((a, s) => a + s[key], 0) * days / 7;
      const delivered = data.plays.reduce((a, p) => a + p.plays, 0);
      if (agreed > 0 && delivered < agreed) {
        const pct = Math.round(delivered / agreed * 100);
        const bucket = Math.floor(daysBetween("2026-01-01", today) / UNDERDELIVERY_REPEAT);
        await notify(env, { key: `underdelivery:${c.id}:${bucket}`, kind: "underdelivery", link_type: "report", link_id: c.id,
          title: `Behind on plays: ${c.client_name}`,
          body: `${Math.round(delivered).toLocaleString("en-GB")} of ${Math.round(agreed).toLocaleString("en-GB")} agreed plays so far (${pct}%), up to ${nice(yesterday)}.` }).run();
      }
    } catch (e) {
      console.error("underdelivery check failed for", c.id, e);
    }
  }
}

// The 15-minute schedule (wrangler.toml [triggers]).
export async function runScheduledChecks(env) {
  await ensureSchema(env);
  const jobs = [["campaign rules", runCampaignRules], ["screens", checkScreens], ["jamboxes", checkJamBoxes],
    ["underdelivery", checkUnderdelivery]];
  for (const [name, job] of jobs) {
    try { await job(env); } catch (e) { console.error(`notifications: ${name} check failed`, e); }
  }
}

// ----------------------------------------------------------------------------- routes
export async function handleNotifications(request, env, pathname) {
  if (!pathname.startsWith("/api/notifications")) return null;
  const email = requireAccess(request) || env.DEV_LOCAL_EMAIL;
  if (!email) return json({ error: "unauthorized" }, 401);
  try {
    await ensureSchema(env);
    let res;
    if (pathname === "/api/notifications" && request.method === "GET") {
      try { await runCampaignRules(env); } catch (e) { console.error("notifications: rules failed", e); }
      const since = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString();
      const { results } = await env.DB.prepare(
        `SELECT n.*, (r.notification_id IS NOT NULL) AS read FROM notifications n
         LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_email = ?
         WHERE n.created_at >= ? ORDER BY n.created_at DESC, n.id DESC LIMIT 200`).bind(email, since).all();
      const items = results.map((n) => ({ ...n, read: !!n.read }));
      res = json({ unread: items.filter((n) => !n.read).length, items });
    } else if (pathname === "/api/notifications/read" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) { /* empty */ }
      const now = new Date().toISOString();
      if (body.all) {
        await env.DB.prepare(`INSERT OR IGNORE INTO notification_reads (notification_id, user_email, read_at)
          SELECT id, ?, ? FROM notifications`).bind(email, now).run();
      } else {
        const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isFinite).slice(0, 200);
        if (ids.length) {
          await env.DB.batch(ids.map((id) => env.DB.prepare(
            "INSERT OR IGNORE INTO notification_reads (notification_id, user_email, read_at) VALUES (?,?,?)").bind(id, email, now)));
        }
      }
      res = json({ ok: true });
    } else {
      res = json({ error: "not found" }, 404);
    }
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    console.error("notifications error", e);
    return json({ error: `Something went wrong: ${String(e && e.message || e).slice(0, 200)}` }, 500);
  }
}
