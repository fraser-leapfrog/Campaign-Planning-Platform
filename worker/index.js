// Single Worker entry point: handles /api/campaigns/* itself, and falls back to
// the static assets binding (env.ASSETS) for everything else — the board's HTML,
// fonts, and logo. This replaces the old Pages-Functions file-based routes, which
// don't apply to this project (it's a Git-connected Worker with static assets,
// not classic Cloudflare Pages).

import { json, requireAccess, rowToJson, normaliseLoc } from "./utils.js";
import { handleBillboard } from "./billboard.js";
import { handleNotifications, runScheduledChecks } from "./notifications.js";
import { handleWebsite } from "./website.js";
import { handleClient, handleShareAdmin, refreshDueShares } from "./share.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // Client share pages (/client/*): public via an Access bypass, protected by the report's password.
    const client = await handleClient(request, env, pathname);
    if (client) return client;

    if (pathname === "/api/campaigns") {
      if (request.method === "GET") return handleList(request, env);
      if (request.method === "POST") return handleCreate(request, env);
    }

    if (pathname === "/api/campaigns/replace-all" && request.method === "POST") {
      return handleReplaceAll(request, env);
    }

    const idMatch = pathname.match(/^\/api\/campaigns\/([^/]+)$/);
    if (idMatch && request.method === "PATCH") {
      return handlePatch(request, env, decodeURIComponent(idMatch[1]));
    }

    // Marketing Planner — completely separate data from the WMC/Swansea campaigns
    // above (its own tables: marketing_ideas, marketing_calendar).
    if (pathname === "/api/ideas") {
      if (request.method === "GET") return handleIdeasList(request, env);
      if (request.method === "POST") return handleIdeaCreate(request, env);
    }
    const ideaIdMatch = pathname.match(/^\/api\/ideas\/([^/]+)$/);
    if (ideaIdMatch && request.method === "PATCH") {
      return handleIdeaPatch(request, env, decodeURIComponent(ideaIdMatch[1]));
    }
    if (ideaIdMatch && request.method === "DELETE") {
      return handleIdeaDelete(request, env, decodeURIComponent(ideaIdMatch[1]));
    }

    if (pathname === "/api/marketing-calendar") {
      if (request.method === "GET") return handleMarketingList(request, env);
      if (request.method === "POST") return handleMarketingCreate(request, env);
    }
    const mcIdMatch = pathname.match(/^\/api\/marketing-calendar\/([^/]+)$/);
    if (mcIdMatch && request.method === "PATCH") {
      return handleMarketingPatch(request, env, decodeURIComponent(mcIdMatch[1]));
    }
    if (mcIdMatch && request.method === "DELETE") {
      return handleMarketingDelete(request, env, decodeURIComponent(mcIdMatch[1]));
    }

    // Billboard Reporting — client proof-of-play/footfall reports (own billboard_* tables).
    const share = await handleShareAdmin(request, env, pathname);   // client link settings
    if (share) return share;
    const billboard = await handleBillboard(request, env, pathname);
    if (billboard) return billboard;

    // Website — analytics for leapfrogadvertising.com (worker/website.js, web_* tables).
    const website = await handleWebsite(request, env, pathname);
    if (website) return website;

    // Notifications — the bell in the top bar (worker/notifications.js).
    const notes = await handleNotifications(request, env, pathname);
    if (notes) return notes;

    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

    // Anything that isn't an API route is a static asset (index.html, fonts, logo).
    return env.ASSETS.fetch(request);
  },

  // Every 15 minutes (wrangler.toml [triggers]): notification rules plus the screen, JamBox and
  // daily under-delivery checks that need Navori/Datajam.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledChecks(env));
    ctx.waitUntil(refreshDueShares(env).catch((e) => console.error("client link refresh failed", e)));   // ~hourly per link
  },
};

// A date typed as 1/11/26 into <input type="date"> arrives as year 0026, which silently
// files the campaign ~2,000 years in the past (it shows as Live Now and inflates the
// analytics). Two-digit years are always meant as 20xx, so fix them on the way in...
function normaliseDate(v) {
  if (typeof v !== "string") return v;
  const m = v.match(/^00(\d\d)-(\d\d-\d\d)$/);
  return m ? `20${m[1]}-${m[2]}` : v;
}

// Keeps each campaign's status in step with its dates, so nobody has to remember
// to flip it by hand. Runs on every list request (the board polls every 20s and
// refreshes after every edit), which means a date change is corrected the moment
// it's saved and ended campaigns tick over to Completed with no cron needed.
//   - end date has passed                      -> Completed
//   - start date is still ahead, but it was
//     sitting at Live / In Flight / Completed  -> Scheduled (i.e. back to Upcoming)
// "Today" is the UK calendar date, not UTC, so campaigns roll over at UK midnight.
async function reconcileStatuses(env) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  const today = `${get("year")}-${get("month")}-${get("day")}`;

  await env.DB.batch([
    // "Swansea" became Quadrant Shopping Centre + Parc Tawe Retail Park: every campaign that was
    // ticked Swansea is now ticked at both (archived ones too, so restoring them is right).
    // One statement, safe to re-run, and a no-op once nothing says Swansea any more.
    env.DB.prepare(
      `UPDATE campaigns SET loc = REPLACE(loc, '"Swansea"', '"Quadrant Shopping Centre","Parc Tawe Retail Park"'),
                            updated_at = datetime('now')
       WHERE loc LIKE '%"Swansea"%'`
    ),
    // ...and repair any dates that already got in (runs first, so the status rules below see real dates).
    env.DB.prepare(`UPDATE campaigns SET start_date = '20' || substr(start_date, 3) WHERE start_date GLOB '00[0-9][0-9]-*'`),
    env.DB.prepare(`UPDATE campaigns SET end_date = '20' || substr(end_date, 3) WHERE end_date GLOB '00[0-9][0-9]-*'`),
    env.DB.prepare(`UPDATE marketing_calendar SET date = '20' || substr(date, 3) WHERE date GLOB '00[0-9][0-9]-*'`),
    env.DB.prepare(`UPDATE marketing_calendar SET end_date = '20' || substr(end_date, 3) WHERE end_date GLOB '00[0-9][0-9]-*'`),
    env.DB.prepare(
      `UPDATE campaigns SET status = 'Completed', updated_at = datetime('now')
       WHERE end_date IS NOT NULL AND end_date < ?1 AND status != 'Completed'`
    ).bind(today),
    // The end_date guard stops a bad row (end before start) flip-flopping between the two rules.
    env.DB.prepare(
      `UPDATE campaigns SET status = 'Scheduled', updated_at = datetime('now')
       WHERE start_date IS NOT NULL AND start_date > ?1
         AND (end_date IS NULL OR end_date >= ?1)
         AND status IN ('Live', 'In Flight', 'Completed')`
    ).bind(today),
  ]);
}

async function handleList(request, env) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  // A failed tidy-up shouldn't stop the board loading.
  try { await reconcileStatuses(env); } catch (err) { console.error("reconcileStatuses failed", err); }

  const { results } = await env.DB.prepare(
    `SELECT id, name AS n, status AS s, loc, deal, retarget AS rt,
            start_date AS "start", end_date AS "end", notes, rotation, deleted
     FROM campaigns
     ORDER BY (start_date IS NULL), start_date`
  ).all();

  return json(results.map(rowToJson));
}

async function handleCreate(request, env) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await request.json();
  if (!body || typeof body.n !== "string" || !body.n.trim()) {
    return json({ error: "campaign name is required" }, 400);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO campaigns (id, name, status, loc, deal, retarget, start_date, end_date, notes, rotation, deleted)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)`
  )
    .bind(
      id,
      body.n.trim(),
      body.s || "Agreed",
      JSON.stringify(normaliseLoc(body.loc)),
      body.deal || null,
      body.rt || null,
      normaliseDate(body.start) || null,
      normaliseDate(body.end) || null,
      body.notes || null,
      body.rotation || null
    )
    .run();

  return json({ id }, 201);
}

async function handlePatch(request, env, id) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await request.json();
  const colByField = {
    n: "name",
    s: "status",
    deal: "deal",
    rt: "retarget",
    start: "start_date",
    end: "end_date",
    notes: "notes",
    rotation: "rotation",
    deleted: "deleted",
  };

  const sets = [];
  const values = [];
  for (const [field, col] of Object.entries(colByField)) {
    if (!(field in body)) continue;
    sets.push(`${col} = ?`);
    values.push(
      field === "deleted" ? (body[field] ? 1 : 0)
      : field === "start" || field === "end" ? normaliseDate(body[field])
      : body[field]
    );
  }
  if ("loc" in body) {
    sets.push("loc = ?");
    values.push(JSON.stringify(normaliseLoc(body.loc)));
  }
  if (!sets.length) return json({ error: "no fields to update" }, 400);

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const result = await env.DB.prepare(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  if (!result.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true });
}

async function handleReplaceAll(request, env) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await request.json();
  const rows = Array.isArray(body.rows) ? body.rows : [];

  const stmts = [env.DB.prepare("DELETE FROM campaigns")];
  for (const r of rows) {
    if (!r || typeof r.n !== "string") continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO campaigns (id, name, status, loc, deal, retarget, start_date, end_date, notes, rotation, deleted)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      ).bind(
        typeof r.id === "string" && r.id ? r.id : crypto.randomUUID(),
        r.n,
        r.s || "Agreed",
        JSON.stringify(normaliseLoc(r.loc)),
        r.deal || null,
        r.rt || null,
        normaliseDate(r.start) || null,
        normaliseDate(r.end) || null,
        r.notes || null,
        r.rotation || null,
        r.deleted ? 1 : 0
      )
    );
  }

  await env.DB.batch(stmts);
  return json({ ok: true, count: stmts.length - 1 });
}

/* ---------- Marketing Planner (separate from the campaigns above) ---------- */

async function handleIdeasList(request, env) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const { results } = await env.DB.prepare(
    `SELECT id, text, notes, created_at, updated_at
     FROM marketing_ideas
     ORDER BY COALESCE(updated_at, created_at) DESC`
  ).all();
  return json(results);
}

async function handleIdeaCreate(request, env) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await request.json();
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return json({ error: "idea text is required" }, 400);
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO marketing_ideas (id, text) VALUES (?1, ?2)`)
    .bind(id, body.text.trim())
    .run();

  return json({ id }, 201);
}

async function handleIdeaPatch(request, env, id) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await request.json();
  const colByField = { text: "text", notes: "notes" };

  const sets = [];
  const values = [];
  for (const [field, col] of Object.entries(colByField)) {
    if (!(field in body)) continue;
    sets.push(`${col} = ?`);
    values.push(body[field]);
  }
  if (!sets.length) return json({ error: "no fields to update" }, 400);

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const result = await env.DB.prepare(`UPDATE marketing_ideas SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  if (!result.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true });
}

async function handleIdeaDelete(request, env, id) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const result = await env.DB.prepare(`DELETE FROM marketing_ideas WHERE id = ?`).bind(id).run();
  if (!result.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true });
}

// Content pillars a calendar entry can belong to (several at once). Stored as a JSON array.
const MARKETING_PILLARS = ["People & Community", "Marketing & Advertising Insights", "Brand Growth & Results"];
// Leapfrog's three brand pillars (separate from the content pillars above). Also a JSON array.
const BRAND_PILLARS = ["Trust", "Community", "Visibility"];

// Columns added after the first release: add them to the existing table once.
//   pillars   — JSON array of MARKETING_PILLARS (multi-select)
//   types     — JSON array of channels (Email / LinkedIn / Instagram, multi-select). Replaces the
//               single `type` column, which is copied across once when `types` is first added.
//   post_copy — the text that goes out with the post
//   brand_pillars — JSON array of BRAND_PILLARS (multi-select)
const MARKETING_ADDED_COLUMNS = ["pillars", "types", "post_copy", "brand_pillars"];
let marketingSchemaReady = false;
async function ensureMarketingSchema(env) {
  if (marketingSchemaReady) return;
  const cols = (await env.DB.prepare("PRAGMA table_info(marketing_calendar)").all()).results.map((r) => r.name);
  for (const col of MARKETING_ADDED_COLUMNS) {
    if (cols.includes(col)) continue;
    try {
      await env.DB.prepare(`ALTER TABLE marketing_calendar ADD COLUMN ${col} TEXT`).run();
    } catch (e) {
      if (/duplicate column/i.test(String(e))) continue; // a parallel request added it (and backfills it)
      throw e;
    }
    if (col === "types") {
      await env.DB.prepare(
        `UPDATE marketing_calendar SET types = json_array(type) WHERE type IS NOT NULL AND type != ''`
      ).run();
    }
  }
  marketingSchemaReady = true;
}

function cleanPillars(v, allowed = MARKETING_PILLARS) {
  if (!Array.isArray(v)) return null;
  const out = allowed.filter((p) => v.includes(p));
  return out.length ? JSON.stringify(out) : null;
}

// Any short strings are kept (not just the three current channels), so an old Notion type
// on an existing entry survives an edit unless it's unticked.
function cleanTypes(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const t of v) {
    if (typeof t === "string" && t.trim() && t.length <= 60 && !out.includes(t.trim())) out.push(t.trim());
  }
  return out.length ? JSON.stringify(out) : null;
}

function parseJsonList(v) {
  try { const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; }
}

async function handleMarketingList(request, env) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);
  await ensureMarketingSchema(env);

  const { results } = await env.DB.prepare(
    `SELECT id, name, date, end_date, types, status, notes, post_copy, pillars, brand_pillars
     FROM marketing_calendar
     ORDER BY date`
  ).all();
  return json(results.map((r) => ({
    ...r, types: parseJsonList(r.types), pillars: parseJsonList(r.pillars), brand_pillars: parseJsonList(r.brand_pillars),
  })));
}

async function handleMarketingCreate(request, env) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await request.json();
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return json({ error: "campaign name is required" }, 400);
  }
  if (!body.date) return json({ error: "date is required" }, 400);
  await ensureMarketingSchema(env);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO marketing_calendar (id, name, date, end_date, types, status, notes, post_copy, pillars, brand_pillars)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  )
    .bind(id, body.name.trim(), normaliseDate(body.date), normaliseDate(body.end_date) || null, cleanTypes(body.types),
      body.status || null, body.notes || null, body.post_copy || null, cleanPillars(body.pillars),
      cleanPillars(body.brand_pillars, BRAND_PILLARS))
    .run();

  return json({ id }, 201);
}

async function handleMarketingPatch(request, env, id) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await request.json();
  await ensureMarketingSchema(env);
  const colByField = { name: "name", date: "date", end_date: "end_date", types: "types", status: "status", notes: "notes", post_copy: "post_copy", pillars: "pillars", brand_pillars: "brand_pillars" };

  const sets = [];
  const values = [];
  for (const [field, col] of Object.entries(colByField)) {
    if (!(field in body)) continue;
    sets.push(`${col} = ?`);
    values.push(field === "date" || field === "end_date" ? normaliseDate(body[field])
      : field === "pillars" ? cleanPillars(body[field])
      : field === "brand_pillars" ? cleanPillars(body[field], BRAND_PILLARS)
      : field === "types" ? cleanTypes(body[field])
      : body[field]);
  }
  if (!sets.length) return json({ error: "no fields to update" }, 400);

  sets.push("updated_at = datetime('now')");
  values.push(id);

  const result = await env.DB.prepare(`UPDATE marketing_calendar SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();

  if (!result.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true });
}

async function handleMarketingDelete(request, env, id) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const result = await env.DB.prepare(`DELETE FROM marketing_calendar WHERE id = ?`).bind(id).run();
  if (!result.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true });
}
