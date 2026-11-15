// Website tab: analytics for www.leapfrogadvertising.com.
// The website's own Worker (leapfrog-website repo, worker/index.js) records page views, visits and
// conversions into the web_* tables of this database; this file only reads them.
//
//   GET /api/website/summary?days=30   everything the Analytics view needs for the last N UK days

import { json, requireAccess } from "./utils.js";
import { ensureWebSchema } from "./website-schema.js";

const DAY = 864e5;
let schemaReady = null;

export async function handleWebsite(request, env, pathname) {
  if (!pathname.startsWith("/api/website")) return null;
  // Behind Cloudflare Access in production; DEV_LOCAL_EMAIL is only ever set by `wrangler dev --var`.
  if (!(requireAccess(request) || env.DEV_LOCAL_EMAIL)) return json({ error: "unauthorised" }, 401);
  if (!schemaReady) schemaReady = ensureWebSchema(env.DB).catch((e) => { schemaReady = null; throw e; });
  await schemaReady;

  if (pathname === "/api/website/summary" && request.method === "GET") {
    const days = Math.min(400, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 30));
    const res = json(await summary(env.DB, days));
    res.headers.set("cache-control", "no-store");
    return res;
  }
  return json({ error: "not found" }, 404);
}

// ----------------------------------------------------------------------------- UK days
const ukDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(ms));
function ukOffsetMs(ms) {
  // London's offset from UTC at this moment (0 in winter, +1h in summer).
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60000) * 60000;
}
function ukMidnight(dayStr) {
  const guess = Date.parse(`${dayStr}T00:00:00Z`);
  return guess - ukOffsetMs(guess);
}

// ----------------------------------------------------------------------------- summary
async function summary(db, days) {
  const now = Date.now();
  const today = ukDay(now);
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(ukDay(ukMidnight(today) - i * DAY + 12 * 3600e3));
  const since = ukMidnight(dayList[0]);
  const prevSince = since - (ukMidnight(today) + DAY - since);
  const off = Math.round(ukOffsetMs(now) / 1000);   // SQLite day grouping (exact except on clock-change nights)

  const [sessions, pvDaily, pages, conversions, prevS, prevPv, prevC, first] = await db.batch([
    db.prepare(`SELECT started_at, visitor, channel, source, medium, campaign, landing, device, country, pages
                FROM web_sessions WHERE started_at >= ?`).bind(since),
    db.prepare(`SELECT strftime('%Y-%m-%d', ts / 1000 + ?, 'unixepoch') AS day, COUNT(*) AS n
                FROM web_pageviews WHERE ts >= ? GROUP BY day`).bind(off, since),
    db.prepare(`SELECT path, COUNT(*) AS views, COUNT(DISTINCT session_id) AS sessions
                FROM web_pageviews WHERE ts >= ? GROUP BY path ORDER BY views DESC LIMIT 25`).bind(since),
    db.prepare(`SELECT id, ts, form, page, campaign_type, area, name, company, channel, source, medium, campaign,
                landing, referrer, device FROM web_conversions WHERE ts >= ? ORDER BY ts DESC LIMIT 1000`).bind(since),
    db.prepare(`SELECT COUNT(*) AS sessions, COUNT(DISTINCT visitor || strftime('%Y-%m-%d', started_at / 1000, 'unixepoch')) AS visitors
                FROM web_sessions WHERE started_at >= ? AND started_at < ?`).bind(prevSince, since),
    db.prepare(`SELECT COUNT(*) AS n FROM web_pageviews WHERE ts >= ? AND ts < ?`).bind(prevSince, since),
    db.prepare(`SELECT COUNT(*) AS n FROM web_conversions WHERE ts >= ? AND ts < ?`).bind(prevSince, since),
    db.prepare(`SELECT MIN(started_at) AS first FROM web_sessions`),
  ]);
  const S = sessions.results, C = conversions.results;

  // Daily series
  const daily = Object.fromEntries(dayList.map((d) => [d, { day: d, views: 0, sessions: 0, visitors: new Set(), conversions: 0 }]));
  for (const r of pvDaily.results) if (daily[r.day]) daily[r.day].views = r.n;
  for (const s of S) { const d = daily[ukDay(s.started_at)]; if (d) { d.sessions++; d.visitors.add(s.visitor); } }
  for (const c of C) { const d = daily[ukDay(c.ts)]; if (d) d.conversions++; }
  const dailyOut = dayList.map((d) => ({ ...daily[d], visitors: daily[d].visitors.size }));

  // Breakdowns: sessions from web_sessions, conversions from web_conversions (attributed at the time)
  const group = (keyOf, label, withConversions = true) => {
    const m = new Map();
    const get = (k) => { if (!m.has(k)) m.set(k, { ...label(k), sessions: 0, pageviews: 0, conversions: 0, enquiries: 0, guides: 0 }); return m.get(k); };
    for (const s of S) { const g = get(keyOf(s)); g.sessions++; g.pageviews += s.pages || 0; }
    if (withConversions) for (const c of C) { const g = get(keyOf(c)); g.conversions++; g[c.form === "guide" ? "guides" : "enquiries"]++; }
    return [...m.values()].sort((a, b) => b.sessions - a.sessions || b.conversions - a.conversions);
  };
  const srcKey = (r) => `${r.source || "(not set)"}\u0000${r.medium || "(not set)"}`;

  const totals = {
    visitors: dailyOut.reduce((a, d) => a + d.visitors, 0),
    sessions: S.length,
    pageviews: dailyOut.reduce((a, d) => a + d.views, 0),
    conversions: C.length,
    enquiries: C.filter((c) => c.form !== "guide").length,
    guides: C.filter((c) => c.form === "guide").length,
  };
  return {
    days, since, today, generated: now, first_data: first.results[0]?.first || null,
    totals,
    previous: { sessions: prevS.results[0].sessions, visitors: prevS.results[0].visitors, pageviews: prevPv.results[0].n, conversions: prevC.results[0].n },
    daily: dailyOut,
    channels: group((r) => r.channel || "Direct", (k) => ({ channel: k })),
    sources: group(srcKey, (k) => { const [source, medium] = k.split("\u0000"); return { source, medium }; }).slice(0, 30),
    campaigns: group((r) => r.campaign || "", (k) => ({ campaign: k })).filter((g) => g.campaign).slice(0, 30),
    landings: group((r) => r.landing || "/", (k) => ({ path: k })).slice(0, 25),
    devices: group((r) => r.device || "Unknown", (k) => ({ device: k })),
    countries: group((r) => r.country || "??", (k) => ({ country: k }), false).slice(0, 10),
    pages: pages.results,
    conversions: C,
  };
}
