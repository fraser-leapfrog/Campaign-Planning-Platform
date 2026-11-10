// Billboard Reporting: client proof-of-play + footfall reports.
//
// Ported from the local Python tool (~/Downloads/leapfrog-campaign-reports). The Worker
// only stores settings and fetches raw numbers from the two APIs; all the maths and
// the report itself run in the browser (public/billboard/*).
//
//   Navori QL  (plays)    POST https://saas.navori.com/NavoriService/Api/<Method>, token header
//   Datajam    (footfall) GET  https://datajamportal.com/CustomerAPI/<Endpoint>/ with a JSON BODY
//
// Credentials are Worker secrets (Settings -> Variables and Secrets), never in the repo:
//   NAVORI_USERNAME, NAVORI_PASSWORD, DATAJAM_EMAIL, DATAJAM_PASSWORD
//
// Datajam gotcha: it only accepts GET *with a JSON body*. The Workers fetch() refuses to
// send a body on GET, so datajamGet() writes the HTTP request by hand over a TLS socket
// (cloudflare:sockets). datajamportal.com is not behind Cloudflare, so sockets can reach it.
//
// Verified API quirks (see the Python tool's README):
//   * Navori GetReportings: GroupByDate/GroupByGroup=true MERGE rows; use false/false for
//     one row per player/content/day. Duration/TotalDuration are milliseconds.
//   * Datajam GetData: max 30 days per call; row Date is "14-May" (no year); DwellTime adds a
//     duplicate "Aggr Data" row.

import { connect } from "cloudflare:sockets";
import { json, requireAccess } from "./utils.js";

// --------------------------------------------------------------------------- schema
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS billboard_screens (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE,
     location TEXT NOT NULL DEFAULT '',
     navori_player_id INTEGER,
     datajam_project TEXT,
     datajam_device TEXT,
     agreed_week_1_6 INTEGER,
     agreed_week_1_18 INTEGER,
     active INTEGER NOT NULL DEFAULT 1,
     notes TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS billboard_campaigns (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     client_name TEXT NOT NULL,
     start_date TEXT NOT NULL,
     end_date TEXT NOT NULL,
     screen_ids TEXT NOT NULL DEFAULT '[]',
     artworks TEXT NOT NULL DEFAULT '[]',
     share_of_voice TEXT NOT NULL DEFAULT '1/6',
     include_footfall INTEGER NOT NULL DEFAULT 1,
     include_extra_pages INTEGER NOT NULL DEFAULT 1,
     notes TEXT NOT NULL DEFAULT '',
     created_by TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS billboard_photos (
     campaign_id INTEGER PRIMARY KEY,
     data_url TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];

// First-run data, copied from the local tool (Nov 2026). Agreed plays are per SCREEN per week;
// a location's total is the sum of its screens (Parc Tawe 15,960 = 2 x 7,980; WMC 17,640 = 3 x 5,880).
const SEED_SCREENS = [
  ["Quadrant", "Quadrant Shopping Centre, Swansea", 123123, "Leapfrog", "JB005742", 5880, 1960],
  ["Parc Tawe Upper", "Parc Tawe Retail Park, Swansea", 123124, "Leapfrog", "JB005741", 7980, 2660],
  ["Parc Tawe Lower", "Parc Tawe Retail Park, Swansea", 123125, "Leapfrog", "JB005741", 7980, 2660],
  ["WMC - North", "Wales Millennium Centre", 127312, "Leapfrog", "JBNB000013", 5880, 1960],
  ["WMC - Middle", "Wales Millennium Centre", 127313, "Leapfrog", "JBNB000013", 5880, 1960],
  ["WMC - South", "Wales Millennium Centre", 127314, "Leapfrog", "JBNB000013", 5880, 1960],
];
const SEED_CAMPAIGNS = [{
  client_name: "National Waterfront Museum", start_date: "2026-10-01", end_date: "2026-12-07",
  screens: ["Quadrant", "Parc Tawe Upper", "Parc Tawe Lower"],
  artworks: ["NWMS-Quadrant-Screen-Ads-Christmas", "NWMS-Quadrant-Screen-Ads-Christmas2",
    "NWMS-Quadrant-Screen-Ads-Christmas3", "NWMS-Quadrant-Screen-Ads-Christmas4", "NWMS-Quadrant-Screen-Ads-v2",
    "NWMS-Quadrant-Screen-Ads-v23", "NWMS-Quadrant-Screen-Ads-v24", "NWMS-Quadrant-Screen-Ads-v26",
    "NWMS-Quadrant-Screen-Ads2", "NWMS-Quadrant-Screen-Ads5", "NWMS-Quadrant-Screens-winter",
    "NWMS-Quadrant-Screens-winter2"],
  share_of_voice: "1/6",
}];

let schemaReady = false;

// Safe to run from several requests at once (the tab's first load fires three in parallel):
// every statement is idempotent, so a race can't fail or seed twice.
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM billboard_screens").first();
  if (n === 0) {
    // INSERT OR IGNORE: a parallel request that already seeded a name (UNIQUE) just skips it.
    await env.DB.batch(SEED_SCREENS.map((s) => env.DB.prepare(
      `INSERT OR IGNORE INTO billboard_screens (name, location, navori_player_id, datajam_project, datajam_device,
         agreed_week_1_6, agreed_week_1_18) VALUES (?,?,?,?,?,?,?)`).bind(...s)));
    const { results } = await env.DB.prepare("SELECT id, name FROM billboard_screens").all();
    const idByName = Object.fromEntries(results.map((r) => [r.name, r.id]));
    const now = new Date().toISOString();
    await env.DB.batch(SEED_CAMPAIGNS.map((c) => env.DB.prepare(
      `INSERT INTO billboard_campaigns (client_name, start_date, end_date, screen_ids, artworks, share_of_voice,
         created_by, created_at, updated_at)
       SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM billboard_campaigns WHERE client_name = ?)`).bind(
      c.client_name, c.start_date, c.end_date, JSON.stringify(c.screens.map((s) => idByName[s]).filter(Boolean)),
      JSON.stringify(c.artworks), c.share_of_voice, "migrated", now, now, c.client_name)));
  }
  schemaReady = true;
}

// --------------------------------------------------------------------------- helpers
class ApiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);

function todayLondon() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

function* dateChunks(start, end, maxDays) {
  let cur = start;
  while (cur <= end) {
    const chunkEnd = [addDays(cur, maxDays - 1), end].sort()[0];
    yield [cur, chunkEnd];
    cur = addDays(chunkEnd, 1);
  }
}

function needSecrets(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) {
    throw new ApiError(`Not set up yet: add ${missing.join(", ")} as secrets on the Worker ` +
      `(Cloudflare dashboard → Workers → campaign-planning-platform → Settings → Variables and Secrets).`, 503);
  }
}

// --------------------------------------------------------------------------- Navori
class Navori {
  constructor(env) {
    needSecrets(env, ["NAVORI_USERNAME", "NAVORI_PASSWORD"]);
    this.env = env;
    this.base = (env.NAVORI_BASE_URL || "https://saas.navori.com/NavoriService/Api/").replace(/\/?$/, "/");
    this.token = null;
  }

  async login() {
    const data = await this.call("GetToken", { Login: this.env.NAVORI_USERNAME, Password: this.env.NAVORI_PASSWORD },
      false);
    if (!data.Token) throw new ApiError("Navori GetToken returned no token");
    this.token = data.Token;
  }

  async call(method, payload, needsToken = true, retry = true) {
    if (needsToken && !this.token) await this.login();
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (needsToken) headers.Token = this.token;
    let res;
    try {
      res = await fetch(this.base + method, { method: "POST", headers, body: JSON.stringify(payload || {}) });
    } catch (e) {
      throw new ApiError(`Navori ${method}: network error`);
    }
    if (!res.ok) throw new ApiError(`Navori ${method}: HTTP ${res.status}`);
    const data = await res.json();
    const status = String(data.Status || "");
    if (status !== "SUCCESS") {
      if (needsToken && retry && status.toUpperCase().includes("AUTHORI")) {
        this.token = null;
        return this.call(method, payload, needsToken, false);
      }
      throw new ApiError(`Navori ${method}: ${status || "no status"}${method === "GetToken" ? " (check the Navori login)" : ""}`);
    }
    return data;
  }

  async players() {
    return (await this.call("GetPlayers", { Filter: "*" })).PlayerList || [];
  }

  // One row per player/content/day. Dates inclusive. See the quirks at the top of the file.
  async reportings(playerIds, start, end) {
    const data = await this.call("GetReportings", {
      PlayerIdList: playerIds.map(Number), StartDate: start, EndDate: end, GroupByGroup: false, GroupByDate: false,
    });
    return data.ReportingList || [];
  }
}

// --------------------------------------------------------------------------- Datajam
async function datajamGet(env, endpoint, body) {
  needSecrets(env, ["DATAJAM_EMAIL", "DATAJAM_PASSWORD"]);
  const base = new URL(env.DATAJAM_BASE_URL || "https://datajamportal.com/CustomerAPI/");
  const host = base.hostname;
  const path = base.pathname.replace(/\/?$/, "/") + endpoint + "/";   // trailing slash is required (else 301)
  const enc = new TextEncoder();
  const auth = btoa(String.fromCharCode(...enc.encode(`${env.DATAJAM_EMAIL}:${env.DATAJAM_PASSWORD}`)));
  const payload = body ? enc.encode(JSON.stringify(body)) : new Uint8Array();
  const head = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Basic ${auth}\r\n` +
    `Accept: application/json\r\nUser-Agent: leapfrog-billboard-reporting\r\nConnection: close\r\n` +
    (body ? `Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n` : "") + "\r\n";

  const socket = connect({ hostname: host, port: 443 }, { secureTransport: "on", allowHalfOpen: false });
  const read = (async () => {
    const writer = socket.writable.getWriter();
    const headBytes = enc.encode(head);
    const req = new Uint8Array(headBytes.length + payload.length);
    req.set(headBytes); req.set(payload, headBytes.length);
    await writer.write(req);
    writer.releaseLock();
    // Read until the whole response has arrived. Datajam's server drops the TLS connection
    // abruptly afterwards, which the runtime reports as "Network connection lost" - so stop
    // as soon as the response is complete, and only treat a lost connection as an error if
    // it happened before then.
    const reader = socket.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch (e) {
        if (responseComplete(concatBytes(chunks, total))) break;
        throw new ApiError(`Datajam ${endpoint}: connection lost`);
      }
      if (step.done) break;
      chunks.push(step.value);
      total += step.value.length;
      if (responseComplete(concatBytes(chunks, total))) break;
    }
    return chunks;
  })();
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new ApiError(`Datajam ${endpoint}: timed out`)), 60000));
  let chunks;
  try {
    chunks = await Promise.race([read, timeout]);
  } finally {
    try { await socket.close(); } catch (_) { /* already closed */ }
  }

  const raw = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { raw.set(c, off); off += c.length; }
  const { status, headers, bodyBytes } = parseHttpResponse(raw);
  const text = new TextDecoder().decode(bodyBytes);

  if ([301, 302, 307, 308].includes(status)) throw new ApiError(`Datajam ${endpoint}: redirect (missing trailing slash?)`);
  if (status === 401) throw new ApiError("Datajam: authentication failed (check the Datajam login)");
  let data;
  try { data = JSON.parse(text); } catch (_) {
    throw new ApiError(`Datajam ${endpoint}: HTTP ${status}, not JSON`);
  }
  const msg = data && typeof data === "object" ? String(data.msg || data.message || "") : "";
  if (msg.includes("No Data Present")) return null;
  if (msg && !("device_info" in data || "projects" in data)) throw new ApiError(`Datajam ${endpoint}: ${msg}`);
  if (status !== 200) throw new ApiError(`Datajam ${endpoint}: HTTP ${status}`);
  return data;
}

function concatBytes(chunks, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function headerEnd(raw) {
  for (let i = 0; i < raw.length - 3; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) return i;
  }
  return -1;
}

// True once a whole HTTP response (headers + Content-Length body, or a finished chunked body) is in.
function responseComplete(raw) {
  const end = headerEnd(raw);
  if (end < 0) return false;
  const head = new TextDecoder().decode(raw.subarray(0, end)).toLowerCase();
  const body = raw.length - (end + 4);
  const len = head.match(/\r\ncontent-length:\s*(\d+)/);
  if (len) return body >= Number(len[1]);
  if (head.includes("transfer-encoding: chunked")) {
    const tail = new TextDecoder().decode(raw.subarray(Math.max(end + 4, raw.length - 7)));
    return tail.endsWith("0\r\n\r\n");
  }
  return false;   // no length given: read until the server closes
}

function parseHttpResponse(raw) {
  // Find the end of the headers (\r\n\r\n).
  let i = 0;
  while (i < raw.length - 3 && !(raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10)) i++;
  const headText = new TextDecoder().decode(raw.subarray(0, i));
  let bodyBytes = raw.subarray(i + 4);
  const [statusLine, ...lines] = headText.split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  const headers = {};
  for (const l of lines) {
    const k = l.indexOf(":");
    if (k > 0) headers[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim();
  }
  if ((headers["transfer-encoding"] || "").toLowerCase().includes("chunked")) bodyBytes = dechunk(bodyBytes);
  else if (headers["content-length"]) bodyBytes = bodyBytes.subarray(0, Number(headers["content-length"]));
  return { status, headers, bodyBytes };
}

function dechunk(bytes) {
  const out = [];
  let pos = 0;
  const dec = new TextDecoder();
  while (pos < bytes.length) {
    let lineEnd = pos;
    while (lineEnd < bytes.length - 1 && !(bytes[lineEnd] === 13 && bytes[lineEnd + 1] === 10)) lineEnd++;
    const size = parseInt(dec.decode(bytes.subarray(pos, lineEnd)).split(";")[0], 16);
    if (!size) break;
    const start = lineEnd + 2;
    out.push(bytes.subarray(start, start + size));
    pos = start + size + 2;
  }
  const total = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of out) { total.set(c, off); off += c.length; }
  return total;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// GetData rows say "14-May" with no year: map each day in the (<=30-day) chunk back to its full date.
function dayMonthLookup(start, end) {
  const out = {};
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const dt = toDate(d);
    out[`${dt.getUTCDate()}-${MONTHS[dt.getUTCMonth()]}`] = d;
  }
  return out;
}

function dayMonthKey(text) {
  const [day, mon] = String(text || "").split("-");
  return `${parseInt(day, 10)}-${(mon || "").trim().slice(0, 3).toLowerCase()}`;
}

async function datajamDaily(env, project, device, start, end) {
  const rows = [];
  for (const [cs, ce] of dateChunks(start, end, 30)) {
    const data = await datajamGet(env, "GetData", {
      project_name: project, device_number: device, start_date: cs, end_date: ce, type_data: "Impression",
      filter: "Default",
    });
    if (!data) continue;
    const lookup = dayMonthLookup(cs, ce);
    for (const r of data.device_info || []) rows.push({ ...r, iso_date: lookup[dayMonthKey(r.Date)] || null });
  }
  return rows;
}

// --------------------------------------------------------------------------- data fetch
async function fetchCampaignData(env, campaign, screens, through) {
  const warnings = [];
  const navori = new Navori(env);
  const wanted = new Set(campaign.artworks);
  const start = campaign.start_date;

  // ---- plays (Navori), per screen, in <=31-day chunks
  const totals = new Map();   // key screen|date|artwork -> [plays, airtime_s]
  await Promise.all(screens.map(async (s) => {
    if (!s.navori_player_id) {
      warnings.push(`${s.name}: no Navori player set, so no play data for this screen.`);
      return;
    }
    for (const [cs, ce] of dateChunks(start, through, 31)) {
      for (const r of await navori.reportings([s.navori_player_id], cs, ce)) {
        if (!wanted.has(r.ContentName)) continue;
        const d = String(r.Date || "").slice(0, 10);
        if (!ISO.test(d)) { warnings.push(`${s.name}: a row for '${r.ContentName}' had no date.`); continue; }
        const key = `${s.id}|${d}|${r.ContentName}`;
        const t = totals.get(key) || [0, 0];
        t[0] += Number(r.ImpressionCount || 0);
        t[1] += Number(r.TotalDuration || 0) / 1000;   // ms -> s
        totals.set(key, t);
      }
    }
  }));
  const plays = [...totals.entries()].map(([key, [p, a]]) => {
    const [sid, date, artwork] = key.split("|");
    return { screen_id: Number(sid), date, artwork: key.slice(sid.length + date.length + 2), plays: p, airtime_s: a };
  });
  const played = new Set(plays.map((p) => p.artwork));
  for (const a of [...wanted].sort()) {
    if (!played.has(a)) warnings.push(`Artwork '${a}' has no plays on the campaign screens between ${start} and ${through}.`);
  }

  // ---- footfall (Datajam), each JamBox once
  const footfall = [];
  if (campaign.include_footfall) {
    for (const s of screens) if (!s.datajam_device) warnings.push(`${s.name}: no JamBox set, so no footfall for this screen.`);
    const devices = [...new Map(screens.filter((s) => s.datajam_device)
      .map((s) => [s.datajam_device, [s.datajam_project, s.datajam_device]])).values()];
    const expected = daysBetween(start, through) + 1;
    await Promise.all(devices.map(async ([project, device]) => {
      let rows;
      try {
        rows = await datajamDaily(env, project, device, start, through);
      } catch (e) {
        warnings.push(`JamBox ${device}: ${e.message}`);
        return;
      }
      const seen = new Set();
      const zero = [];
      for (const r of rows) {
        if (r.Device === "Aggr Data") continue;
        if (!r.iso_date) { warnings.push(`JamBox ${device}: skipped a row with unreadable date '${r.Date}'.`); continue; }
        if (seen.has(r.iso_date)) continue;
        seen.add(r.iso_date);
        const hours = Array.from({ length: 24 }, (_, h) => Number(r[`hour${String(h).padStart(2, "0")}`] || 0));
        if (hours.every((v) => v === 0)) zero.push(r.iso_date);
        footfall.push({ project, device, date: r.iso_date, hours });
      }
      if (seen.size < expected) warnings.push(`JamBox ${device}: footfall missing for ${expected - seen.size} of ${expected} days.`);
      if (zero.length) {
        warnings.push(`JamBox ${device}: recorded zero footfall on ${zero.length} day(s) (${zero.sort().slice(0, 6).join(", ")}` +
          `${zero.length > 6 ? ` and ${zero.length - 6} more` : ""}). The sensor may have been offline.`);
      }
    }));
  }

  if (campaign.share_of_voice) {
    const key = campaign.share_of_voice === "1/6" ? "agreed_week_1_6" : "agreed_week_1_18";
    const unrated = screens.filter((s) => !s[key]).map((s) => s.name);
    if (unrated.length) {
      warnings.push(`No agreed ${campaign.share_of_voice} rate set for ${unrated.join(", ")} (Screens tab), ` +
        "so they're left out of the agreed-vs-delivered comparison.");
    }
  }
  return { plays, footfall, warnings };
}

// --------------------------------------------------------------------------- rows <-> JSON
function screenFromRow(r) {
  return { ...r, active: !!r.active };
}

function campaignFromRow(r) {
  return {
    ...r, screen_ids: JSON.parse(r.screen_ids || "[]"), artworks: JSON.parse(r.artworks || "[]"),
    include_footfall: !!r.include_footfall, include_extra_pages: !!r.include_extra_pages,
  };
}

function validateCampaign(c) {
  if (!String(c.client_name || "").trim()) throw new ApiError("Client name is required", 400);
  if (!ISO.test(c.start_date || "") || !ISO.test(c.end_date || "")) throw new ApiError("Start and end dates are required", 400);
  if (c.end_date < c.start_date) throw new ApiError("The end date is before the start date", 400);
  if (!Array.isArray(c.screen_ids) || !c.screen_ids.length) throw new ApiError("Pick at least one screen", 400);
  if (!Array.isArray(c.artworks) || !c.artworks.length) throw new ApiError("Pick at least one artwork", 400);
  if (!["1/6", "1/18", ""].includes(c.share_of_voice)) throw new ApiError("Unknown package", 400);
}

const SCREEN_FIELDS = ["name", "location", "navori_player_id", "datajam_project", "datajam_device",
  "agreed_week_1_6", "agreed_week_1_18", "active", "notes"];

function cleanScreen(b) {
  const s = {};
  for (const f of SCREEN_FIELDS) s[f] = b[f] === "" || b[f] === undefined ? null : b[f];
  s.name = String(s.name || "").trim();
  if (!s.name) throw new ApiError("Screen name is required", 400);
  s.location = String(s.location || "");
  s.notes = String(s.notes || "");
  s.active = s.active === null ? 1 : (s.active ? 1 : 0);
  for (const f of ["navori_player_id", "agreed_week_1_6", "agreed_week_1_18"]) {
    s[f] = s[f] === null ? null : Number(s[f]);
    if (s[f] !== null && !Number.isFinite(s[f])) throw new ApiError(`${f} must be a number`, 400);
  }
  if (!!s.datajam_project !== !!s.datajam_device) throw new ApiError("Set both the Datajam project and JamBox, or neither", 400);
  return s;
}

// --------------------------------------------------------------------------- routes
export async function handleBillboard(request, env, pathname) {
  if (!pathname.startsWith("/api/billboard/")) return null;
  // Behind Cloudflare Access in production; DEV_LOCAL_EMAIL is only ever set by `wrangler dev --var`.
  const email = requireAccess(request) || env.DEV_LOCAL_EMAIL;
  if (!email) return json({ error: "unauthorized" }, 401);
  try {
    await ensureSchema(env);
    return await route(request, env, pathname.slice("/api/billboard".length), email);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("billboard error", e);
    // Internal tool behind Cloudflare Access, so showing the message helps diagnose problems.
    return json({ error: `Something went wrong on the server: ${String(e && e.message || e).slice(0, 300)}` }, 500);
  }
}

async function route(request, env, path, email) {
  const m = request.method;
  const url = new URL(request.url);
  const body = async () => { try { return await request.json(); } catch (_) { throw new ApiError("Bad JSON", 400); } };
  let match;

  if (path === "/status" && m === "GET") {
    return json({
      navori: !!(env.NAVORI_USERNAME && env.NAVORI_PASSWORD), datajam: !!(env.DATAJAM_EMAIL && env.DATAJAM_PASSWORD),
      today: todayLondon(),
    });
  }

  // ---- screens
  if (path === "/screens" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM billboard_screens ORDER BY name").all();
    return json(results.map(screenFromRow));
  }
  if (path === "/screens" && m === "POST") {
    const s = cleanScreen(await body());
    try {
      const r = await env.DB.prepare(`INSERT INTO billboard_screens (${SCREEN_FIELDS.join(",")}) VALUES (${SCREEN_FIELDS.map(() => "?").join(",")}) RETURNING *`)
        .bind(...SCREEN_FIELDS.map((f) => s[f])).first();
      return json(screenFromRow(r), 201);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new ApiError("A screen with that name already exists", 409);
      throw e;
    }
  }
  if ((match = path.match(/^\/screens\/(\d+)$/))) {
    const id = Number(match[1]);
    if (m === "PATCH") {
      const s = cleanScreen(await body());
      try {
        const r = await env.DB.prepare(`UPDATE billboard_screens SET ${SCREEN_FIELDS.map((f) => `${f}=?`).join(",")} WHERE id=? RETURNING *`)
          .bind(...SCREEN_FIELDS.map((f) => s[f]), id).first();
        if (!r) throw new ApiError("Screen not found", 404);
        return json(screenFromRow(r));
      } catch (e) {
        if (String(e).includes("UNIQUE")) throw new ApiError("A screen with that name already exists", 409);
        throw e;
      }
    }
    if (m === "DELETE") {
      const { results } = await env.DB.prepare("SELECT screen_ids FROM billboard_campaigns").all();
      if (results.some((r) => JSON.parse(r.screen_ids || "[]").includes(id))) {
        throw new ApiError("This screen is used by a saved campaign. Untick Active instead.", 409);
      }
      await env.DB.prepare("DELETE FROM billboard_screens WHERE id=?").bind(id).run();
      return json({ ok: true });
    }
  }

  // ---- campaigns
  if (path === "/campaigns" && m === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT c.*, (p.campaign_id IS NOT NULL) AS has_photo FROM billboard_campaigns c
       LEFT JOIN billboard_photos p ON p.campaign_id = c.id ORDER BY c.start_date DESC, c.id DESC`).all();
    return json(results.map((r) => ({ ...campaignFromRow(r), has_photo: !!r.has_photo })));
  }
  if (path === "/campaigns" && m === "POST") {
    const c = await body();
    validateCampaign(c);
    const now = new Date().toISOString();
    const r = await env.DB.prepare(
      `INSERT INTO billboard_campaigns (client_name, start_date, end_date, screen_ids, artworks, share_of_voice,
         include_footfall, include_extra_pages, notes, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`).bind(
      c.client_name.trim(), c.start_date, c.end_date, JSON.stringify(c.screen_ids.map(Number)),
      JSON.stringify([...new Set(c.artworks)]), c.share_of_voice, c.include_footfall ? 1 : 0,
      c.include_extra_pages ? 1 : 0, String(c.notes || ""), email, now, now).first();
    return json(campaignFromRow(r), 201);
  }
  if ((match = path.match(/^\/campaigns\/(\d+)$/))) {
    const id = Number(match[1]);
    if (m === "PATCH") {
      const c = await body();
      validateCampaign(c);
      const r = await env.DB.prepare(
        `UPDATE billboard_campaigns SET client_name=?, start_date=?, end_date=?, screen_ids=?, artworks=?,
           share_of_voice=?, include_footfall=?, include_extra_pages=?, notes=?, updated_at=? WHERE id=? RETURNING *`).bind(
        c.client_name.trim(), c.start_date, c.end_date, JSON.stringify(c.screen_ids.map(Number)),
        JSON.stringify([...new Set(c.artworks)]), c.share_of_voice, c.include_footfall ? 1 : 0,
        c.include_extra_pages ? 1 : 0, String(c.notes || ""), new Date().toISOString(), id).first();
      if (!r) throw new ApiError("Campaign not found", 404);
      return json(campaignFromRow(r));
    }
    if (m === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM billboard_campaigns WHERE id=?").bind(id),
        env.DB.prepare("DELETE FROM billboard_photos WHERE campaign_id=?").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  // ---- campaign photo (optional, one per campaign; resized in the browser before upload)
  if ((match = path.match(/^\/campaigns\/(\d+)\/photo$/))) {
    const id = Number(match[1]);
    if (m === "GET") {
      const r = await env.DB.prepare("SELECT data_url FROM billboard_photos WHERE campaign_id=?").bind(id).first();
      return r ? json({ data_url: r.data_url }) : json({ error: "no photo" }, 404);
    }
    if (m === "PUT") {
      const { data_url } = await body();
      if (!/^data:image\/(jpeg|png);base64,/.test(data_url || "")) throw new ApiError("Not an image", 400);
      if (data_url.length > 1_800_000) throw new ApiError("Photo too large (keep it under about 1.3 MB)", 413);
      await env.DB.prepare(`INSERT INTO billboard_photos (campaign_id, data_url, updated_at) VALUES (?,?,?)
        ON CONFLICT(campaign_id) DO UPDATE SET data_url=excluded.data_url, updated_at=excluded.updated_at`)
        .bind(id, data_url, new Date().toISOString()).run();
      return json({ ok: true });
    }
    if (m === "DELETE") {
      await env.DB.prepare("DELETE FROM billboard_photos WHERE campaign_id=?").bind(id).run();
      return json({ ok: true });
    }
  }

  // ---- fetch a campaign's numbers (raw rows; the browser does the maths)
  if ((match = path.match(/^\/campaigns\/(\d+)\/data$/)) && m === "GET") {
    const row = await env.DB.prepare("SELECT * FROM billboard_campaigns WHERE id=?").bind(Number(match[1])).first();
    if (!row) throw new ApiError("Campaign not found", 404);
    const campaign = campaignFromRow(row);
    const yesterday = addDays(todayLondon(), -1);
    let through = url.searchParams.get("through");
    through = [ISO.test(through || "") ? through : yesterday, yesterday, campaign.end_date].sort()[0];
    if (through < campaign.start_date) throw new ApiError(`No complete days yet: the campaign starts ${campaign.start_date}.`, 400);
    const ids = campaign.screen_ids;
    const { results } = await env.DB.prepare(
      `SELECT * FROM billboard_screens WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all();
    const byId = Object.fromEntries(results.map((r) => [r.id, screenFromRow(r)]));
    const screens = ids.map((i) => byId[i]).filter(Boolean);
    const data = await fetchCampaignData(env, campaign, screens, through);
    return json({ campaign, screens, start: campaign.start_date, end: through, fetched_at: new Date().toISOString(), ...data });
  }

  // ---- dropdown sources for the Screens tab
  if (path === "/sources" && m === "GET") {
    const out = { players: [], devices: [], errors: [] };
    try {
      out.players = (await new Navori(env).players())
        .map((p) => ({ id: p.Id, name: p.Name, group: p.GroupName })).sort((a, b) => String(a.name).localeCompare(b.name));
    } catch (e) { out.errors.push(e.message); }
    try {
      const projects = (await datajamGet(env, "GetUserProjects")).projects || [];
      for (const p of projects) {
        const info = await datajamGet(env, "GetDeviceInfo", { project_name: p.project_name });
        for (const d of (info && info.device_info) || []) {
          out.devices.push({ project: p.project_name, device: d.device_number, location: d.dev_location_ref,
            status: d.registration_status, last_seen: d.last_seen });
        }
      }
    } catch (e) { out.errors.push(e.message); }
    return json(out);
  }

  // ---- artwork picker: what actually played on these players in this range
  if (path === "/artworks" && m === "GET") {
    const players = (url.searchParams.get("players") || "").split(",").map(Number).filter(Boolean);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    if (!players.length || !ISO.test(start || "") || !ISO.test(end || "") || end < start) return json([]);
    const navori = new Navori(env);
    const counts = new Map();
    for (const [cs, ce] of dateChunks(start, end, 31)) {
      for (const r of await navori.reportings(players, cs, ce)) {
        if (!r.ContentName) continue;
        counts.set(r.ContentName, (counts.get(r.ContentName) || 0) + Number(r.ImpressionCount || 0));
      }
    }
    return json([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([artwork, plays]) => ({ artwork, plays })));
  }

  throw new ApiError("Not found", 404);
}
