// Client share links for Billboard reports: a live, password-protected results page per campaign.
//
//   Internal (behind Cloudflare Access, called from the Billboard tab):
//     GET  /api/billboard/campaigns/:id/share           link status + when the numbers were last refreshed
//     PUT  /api/billboard/campaigns/:id/share           { enabled, password? } turn the link on/off, set a password
//     POST /api/billboard/campaigns/:id/share/refresh   fetch fresh numbers now (~25 s)
//
//   Public, for clients: https://leapfrogadvertising.com/reports/<slug>. The website Worker
//   (Downloads/leapfrog-website) forwards /reports/* here over a service binding as /client/* with
//   X-Client-Base: /reports, so it never passes through Cloudflare Access. The same pages also work
//   at /client/* on The Pond's own address (behind Access), which is handy for previewing.
//     GET  /client/<slug>                  the results page (public/client/index.html)
//     GET  /client/lib/<file>              shared scripts/fonts/logo the page needs (the rest of the app stays private)
//     GET  /client/api/<token>             the stored numbers (needs the session cookie)
//     POST /client/api/<token>/login       { password } -> session cookie (30 days)
//     POST /client/api/<token>/logout
//     GET  /client/api/<token>/photo       the campaign photo, if one was added
//
// Clients never trigger a Navori/Datajam fetch. The cron (every 15 min) refreshes each shared, running
// campaign's numbers about once an hour and stores a cleaned copy in billboard_snapshots: no notes,
// no Navori/Datajam ids, no agreed rates. Agreed plays only appear as "+X% above agreed", and only
// when the campaign really is above (complete days only, rounded down). Numbers stop at the end date.

import { json, requireAccess } from "./utils.js";
import { ensureSchema, fetchCampaignData, todayLondon, addDays, campaignFromRow, screenFromRow } from "./billboard.js";
import { buildModel } from "../public/billboard/model.js";

const REFRESH_EVERY_MIN = 55;      // "hourly", allowing for the 15-minute cron
const RETRY_AFTER_ERROR_MIN = 25;
const KEEP_REFRESHING_DAYS = 3;    // after the end date, to pick up late-syncing plays; then the page is frozen
const MAX_REFRESHES_PER_RUN = 3;   // each takes ~25 s
const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 8;       // per link, per 15 minutes
const PBKDF2_ITERATIONS = 100000;  // the most Workers' WebCrypto allows
const PUBLIC_BASE = "https://leapfrogadvertising.com/reports";   // what clients are sent
const SLUG = "[A-Za-z0-9_-]{4,64}";                              // in URLs (older links were random tokens)
const SLUG_RULE = /^[a-z0-9](?:[a-z0-9-]{2,58})[a-z0-9]$/;       // what can be typed in: 4-60, lowercase, hyphens

// "Cariad Mortgage Solutions" -> "cariad-mortgage-solutions-k7m2". The 4 random characters keep it
// unique and hard to guess; the password is still the real lock.
function defaultSlug(clientName) {
  const base = String(clientName || "report").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "report";
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const rnd = [...crypto.getRandomValues(new Uint8Array(4))].map((n) => chars[n % chars.length]).join("");
  return `${base}-${rnd}`;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS billboard_snapshots (
     campaign_id INTEGER PRIMARY KEY,
     data TEXT,
     fetched_at TEXT,
     attempted_at TEXT,
     error TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS billboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS billboard_share_attempts (token TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_billboard_share_attempts ON billboard_share_attempts(token, at)`,
];

let schemaReady = false;
async function ensureShareSchema(env) {
  await ensureSchema(env);   // campaigns table, incl. the share_* columns
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_billboard_share_token ON billboard_campaigns(share_token)").run();
  schemaReady = true;
}

class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// --------------------------------------------------------------------------- crypto helpers
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const randomB64url = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

async function checkPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored || "").split("$");
  if (kind !== "pbkdf2" || !hash) return false;
  return sameBytes(await pbkdf2(password, fromB64url(salt), Number(iter)), fromB64url(hash));
}

// Random signing key for client session cookies, made once and kept in D1 (no extra secret to set up).
async function cookieKey(env) {
  await env.DB.prepare("INSERT OR IGNORE INTO billboard_settings (key, value) VALUES ('client_cookie_key', ?)")
    .bind(randomB64url(32)).run();
  const { value } = await env.DB.prepare("SELECT value FROM billboard_settings WHERE key='client_cookie_key'").first();
  return crypto.subtle.importKey("raw", fromB64url(value), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

// The cookie is tied to the current password hash, so changing the password signs everyone out.
async function sessionSig(env, token, exp, passwordHash) {
  return b64url(await crypto.subtle.sign("HMAC", await cookieKey(env), enc.encode(`${token}|${exp}|${passwordHash}`)));
}
const cookieName = (token) => `lf_client_${token.slice(0, 12)}`;

async function hasSession(env, request, row) {
  const cookies = Object.fromEntries((request.headers.get("Cookie") || "").split(/;\s*/).filter(Boolean)
    .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]));
  const [exp, sig] = String(cookies[cookieName(row.share_token)] || "").split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return sameBytes(enc.encode(sig), enc.encode(await sessionSig(env, row.share_token, exp, row.share_password)));
}

// --------------------------------------------------------------------------- snapshot (the client's numbers)
function campaignStatus(c, today) {
  if (today < c.start_date) return "upcoming";
  return today > c.end_date ? "complete" : "live";
}

async function screensFor(env, campaign) {
  const ids = campaign.screen_ids;
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(`SELECT * FROM billboard_screens WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).all();
  const byId = Object.fromEntries(results.map((r) => [r.id, screenFromRow(r)]));
  return ids.map((i) => byId[i]).filter(Boolean);
}

// "+X% above agreed", over complete days only (today is still counting), rounded down; null if not above.
function agreedPct(campaign, screens, plays, today) {
  if (campaign.show_agreed === false || !campaign.share_of_voice) return null;
  const last = [addDays(today, -1), campaign.end_date].sort()[0];
  if (last < campaign.start_date) return null;
  const model = buildModel({ campaign, screens, start: campaign.start_date, end: last,
    plays: plays.filter((p) => p.date <= last), footfall: [] });
  const avd = model.agreedVsDelivered();
  if (!avd || !avd.ratio || avd.ratio <= 1) return null;
  const pct = Math.floor((avd.ratio - 1) * 100);
  return pct >= 1 ? pct : null;
}

async function buildSnapshot(env, row) {
  const campaign = campaignFromRow(row);
  const today = todayLondon();
  const screens = await screensFor(env, campaign);
  const through = [today, campaign.end_date].sort()[0];   // the report stops on the end date
  const raw = await fetchCampaignData(env, campaign, screens, through);
  // Footfall sensors get neutral ids (S1, S2…): screens sharing one keep the same id.
  const sensorIds = new Map();
  for (const s of screens) if (s.datajam_device && !sensorIds.has(s.datajam_device)) sensorIds.set(s.datajam_device, `S${sensorIds.size + 1}`);
  return {
    v: 1,
    through,
    partial_date: through === today ? today : null,   // today's numbers are "so far"
    fetched_at: new Date().toISOString(),
    include_footfall: !!campaign.include_footfall && raw.footfall.length > 0,
    agreed_pct: agreedPct(campaign, screens, raw.plays, today),
    screens: screens.map((s) => ({ id: s.id, name: s.name, location: s.location,
      datajam_device: campaign.include_footfall ? sensorIds.get(s.datajam_device) || null : null })),
    plays: raw.plays.map((p) => ({ screen_id: p.screen_id, date: p.date, artwork: p.artwork, plays: p.plays,
      airtime_s: Math.round(p.airtime_s) })),
    footfall: campaign.include_footfall
      ? raw.footfall.map((f) => ({ device: sensorIds.get(f.device), date: f.date, hours: f.hours })) : [],
  };
}

export async function refreshSnapshot(env, row) {
  const now = new Date().toISOString();
  try {
    const snap = await buildSnapshot(env, row);
    await env.DB.prepare(`INSERT INTO billboard_snapshots (campaign_id, data, fetched_at, attempted_at, error) VALUES (?,?,?,?,NULL)
      ON CONFLICT(campaign_id) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at,
        attempted_at=excluded.attempted_at, error=NULL`).bind(row.id, JSON.stringify(snap), snap.fetched_at, now).run();
    return { ok: true };
  } catch (e) {
    // Keep the last good numbers on the client page; just record what went wrong.
    const msg = String((e && e.message) || e).slice(0, 300);
    await env.DB.prepare(`INSERT INTO billboard_snapshots (campaign_id, attempted_at, error) VALUES (?,?,?)
      ON CONFLICT(campaign_id) DO UPDATE SET attempted_at=excluded.attempted_at, error=excluded.error`)
      .bind(row.id, now, msg).run();
    return { ok: false, error: msg };
  }
}

// Cron: refresh the shared campaigns that are running (or ended in the last few days) and due.
export async function refreshDueShares(env) {
  await ensureShareSchema(env);
  const today = todayLondon();
  const fresh = new Date(Date.now() - REFRESH_EVERY_MIN * 60e3).toISOString();
  const retry = new Date(Date.now() - RETRY_AFTER_ERROR_MIN * 60e3).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT c.* FROM billboard_campaigns c LEFT JOIN billboard_snapshots s ON s.campaign_id = c.id
     WHERE c.share_enabled = 1 AND c.start_date <= ?
       AND (s.fetched_at IS NULL                                  -- never fetched
         OR c.updated_at > s.fetched_at                           -- report edited since (screens, dates, artwork...), even after it ended
         OR (c.end_date >= ? AND s.fetched_at < ?))               -- running (or just ended) and due its hourly refresh
       AND (s.error IS NULL OR s.attempted_at < ?)                -- after a failure, wait before retrying
     ORDER BY COALESCE(s.fetched_at, '') LIMIT ?`)
    .bind(today, addDays(today, -KEEP_REFRESHING_DAYS), fresh, retry, MAX_REFRESHES_PER_RUN).all();
  for (const row of results) {
    const r = await refreshSnapshot(env, row);
    if (!r.ok) console.error(`client snapshot ${row.id} failed: ${r.error}`);
  }
  await env.DB.prepare("DELETE FROM billboard_share_attempts WHERE at < ?")
    .bind(new Date(Date.now() - 86400e3).toISOString()).run();
}

// --------------------------------------------------------------------------- internal routes
export async function handleShareAdmin(request, env, pathname) {
  const match = pathname.match(/^\/api\/billboard\/campaigns\/(\d+)\/share(\/refresh)?$/);
  if (!match) return null;
  const email = requireAccess(request) || env.DEV_LOCAL_EMAIL;
  if (!email) return json({ error: "unauthorized" }, 401);
  try {
    await ensureShareSchema(env);
    const id = Number(match[1]);
    const load = () => env.DB.prepare("SELECT * FROM billboard_campaigns WHERE id=?").bind(id).first();
    let row = await load();
    if (!row) throw new HttpError("Campaign not found", 404);
    const m = request.method;

    if (match[2]) {
      if (m !== "POST") throw new HttpError("Not found", 404);
      if (!row.share_enabled) throw new HttpError("Turn the client link on first.", 400);
      if (todayLondon() < row.start_date) return json(await shareStatus(env, row));   // nothing to fetch yet
      await refreshSnapshot(env, row);
      return json(await shareStatus(env, row));
    }
    if (m === "GET") return json(await shareStatus(env, row));
    if (m === "PUT") {
      let b;
      try { b = await request.json(); } catch (_) { throw new HttpError("Bad JSON", 400); }
      const password = typeof b.password === "string" ? b.password.trim() : "";
      if (password && password.length < 6) throw new HttpError("Use at least 6 characters for the password.", 400);
      if (b.enabled && !password && !row.share_password) throw new HttpError("Set a password for the client first.", 400);
      let token = row.share_token || defaultSlug(row.client_name);
      if (typeof b.slug === "string" && b.slug.trim() && b.slug.trim().toLowerCase() !== token) {
        token = b.slug.trim().toLowerCase();
        if (!SLUG_RULE.test(token)) {
          throw new HttpError("Use 4–60 lowercase letters, numbers and hyphens for the address (e.g. cariad-november).", 400);
        }
      }
      const hash = password ? await hashPassword(password) : row.share_password;
      try {
        await env.DB.prepare(`UPDATE billboard_campaigns SET share_token=?, share_password=?, share_enabled=?, share_updated_at=?
          WHERE id=?`).bind(token, hash, b.enabled ? 1 : 0, new Date().toISOString(), id).run();
      } catch (e) {
        if (String(e).includes("UNIQUE")) throw new HttpError("Another report already uses that address. Try a different one.", 409);
        throw e;
      }
      row = await load();
      return json(await shareStatus(env, row));
    }
    throw new HttpError("Not found", 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("share admin error", e);
    return json({ error: `Something went wrong on the server: ${String((e && e.message) || e).slice(0, 300)}` }, 500);
  }
}

async function shareStatus(env, row) {
  const snap = await env.DB.prepare("SELECT fetched_at, attempted_at, error FROM billboard_snapshots WHERE campaign_id=?")
    .bind(row.id).first();
  return {
    enabled: !!row.share_enabled, has_password: !!row.share_password,
    slug: row.share_token || null,
    path: row.share_token ? `/client/${row.share_token}` : null,               // preview on The Pond
    public_url: row.share_token ? `${PUBLIC_BASE}/${row.share_token}` : null,  // what the client gets
    status: campaignStatus(row, todayLondon()),
    fetched_at: (snap && snap.fetched_at) || null, attempted_at: (snap && snap.attempted_at) || null,
    error: (snap && snap.error) || null,
  };
}

// --------------------------------------------------------------------------- public routes
// Only these app files are reachable from a client page; everything else stays behind Access.
const CLIENT_LIB = {
  "model.js": "/billboard/model.js",
  "charts.js": "/billboard/charts.js",
  "logo.png": "/logo.png",
  "icon.png": "/icon.png",
  "Arboria-Book.ttf": "/fonts/Arboria-Book.ttf",
  "Arboria-Medium.ttf": "/fonts/Arboria-Medium.ttf",
  "Arboria-Bold.ttf": "/fonts/Arboria-Bold.ttf",
};

const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

function withHeaders(res, extra = PRIVATE_HEADERS) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return out;
}

function clientJson(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...PRIVATE_HEADERS, ...headers } });
}

export async function handleClient(request, env, pathname) {
  if (pathname !== "/client" && !pathname.startsWith("/client/")) return null;
  const url = new URL(request.url);

  // Behind leapfrogadvertising.com/reports the website Worker says so; cookies and redirects follow it.
  const base = request.headers.get("X-Client-Base") === "/reports" ? "/reports" : "/client";

  // The page's own files. (Normally served as static assets; handled here too for service-binding calls.)
  if (request.method === "GET" && /^\/client\/client\.(js|css)$/.test(pathname)) {
    return withHeaders(await env.ASSETS.fetch(new Request(new URL(pathname, url), { method: "GET" })),
      { "Cache-Control": "no-cache", "X-Robots-Tag": "noindex" });
  }

  let match = pathname.match(/^\/client\/lib\/([\w.-]+)$/);
  if (match) {
    const target = CLIENT_LIB[match[1]];
    if (!target || request.method !== "GET") return new Response("Not found", { status: 404 });
    const res = await env.ASSETS.fetch(new Request(new URL(target, url), { method: "GET" }));
    return withHeaders(res, { "Cache-Control": "public, max-age=3600", "X-Robots-Tag": "noindex" });
  }

  if ((match = pathname.match(new RegExp(`^/client/api/(${SLUG})(/login|/logout|/photo)?$`)))) {
    try {
      await ensureShareSchema(env);
      return await clientApi(request, env, match[1], match[2] || "", base);
    } catch (e) {
      if (e instanceof HttpError) return clientJson({ error: e.message }, e.status);
      console.error("client api error", e);
      return clientJson({ error: "Something went wrong. Please try again shortly." }, 500);
    }
  }

  // The page itself, for any /client/<slug> address (the page reads the slug from the URL).
  if (request.method === "GET" && (match = pathname.match(new RegExp(`^/client/(${SLUG})(/?)$`)))) {
    if (match[2]) return new Response(null, { status: 301, headers: { Location: `${base}/${match[1]}` } });   // its files are relative
    return withHeaders(await env.ASSETS.fetch(new Request(new URL("/client/", url), { method: "GET" })),
      { ...PRIVATE_HEADERS, "Cache-Control": "no-cache" });
  }
  return new Response("Not found", { status: 404, headers: PRIVATE_HEADERS });
}

async function clientApi(request, env, token, action, base) {
  const row = await env.DB.prepare("SELECT * FROM billboard_campaigns WHERE share_token=? AND share_enabled=1").bind(token).first();
  if (!row || !row.share_password) throw new HttpError("This link isn't active. Please ask Leapfrog Advertising for a new one.", 404);
  const m = request.method;

  if (action === "/login") {
    if (m !== "POST") throw new HttpError("Not found", 404);
    const since = new Date(Date.now() - 15 * 60e3).toISOString();
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM billboard_share_attempts WHERE token=? AND at>?")
      .bind(token, since).first();
    if (n >= MAX_FAILED_LOGINS) throw new HttpError("Too many attempts. Please wait 15 minutes and try again.", 429);
    let password = "";
    try { password = String((await request.json()).password || ""); } catch (_) { /* empty */ }
    if (!password || !(await checkPassword(password, row.share_password))) {
      await env.DB.prepare("INSERT INTO billboard_share_attempts (token, at) VALUES (?,?)").bind(token, new Date().toISOString()).run();
      throw new HttpError("That password isn't right.", 401);
    }
    const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    const value = `${exp}.${await sessionSig(env, token, exp, row.share_password)}`;
    return clientJson({ ok: true }, 200, {
      "Set-Cookie": `${cookieName(token)}=${value}; Path=${base}/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
    });
  }
  if (action === "/logout") {
    if (m !== "POST") throw new HttpError("Not found", 404);
    return clientJson({ ok: true }, 200, { "Set-Cookie": `${cookieName(token)}=; Path=${base}/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
  }

  if (m !== "GET") throw new HttpError("Not found", 404);
  if (!(await hasSession(env, request, row))) return clientJson({ needs_password: true }, 401);

  if (action === "/photo") {
    const p = await env.DB.prepare("SELECT data_url FROM billboard_photos WHERE campaign_id=?").bind(row.id).first();
    const mm = p && p.data_url.match(/^data:(image\/(?:jpeg|png));base64,(.*)$/);
    if (!mm) throw new HttpError("No photo", 404);
    return new Response(Uint8Array.from(atob(mm[2]), (c) => c.charCodeAt(0)), {
      headers: { "content-type": mm[1], "Cache-Control": "private, max-age=3600", "X-Robots-Tag": "noindex" } });
  }

  const today = todayLondon();
  const snap = await env.DB.prepare("SELECT data FROM billboard_snapshots WHERE campaign_id=? AND data IS NOT NULL").bind(row.id).first();
  const hasPhoto = !!(await env.DB.prepare("SELECT 1 AS x FROM billboard_photos WHERE campaign_id=?").bind(row.id).first());
  const status = campaignStatus(row, today);
  const data = snap && status !== "upcoming" ? JSON.parse(snap.data) : null;   // nothing to show before the start
  return clientJson({
    client_name: row.client_name, start_date: row.start_date, end_date: row.end_date, today,
    status, has_photo: hasPhoto,
    // Before the first refresh (or before the start date) there are no numbers yet.
    ...(data || { pending: true }),
    // A day that was "so far" when fetched is complete once it's in the past.
    partial_date: data && data.partial_date === today ? today : null,
  });
}
