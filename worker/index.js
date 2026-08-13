// Single Worker entry point: handles /api/campaigns/* itself, and falls back to
// the static assets binding (env.ASSETS) for everything else — the board's HTML,
// fonts, and logo. This replaces the old Pages-Functions file-based routes, which
// don't apply to this project (it's a Git-connected Worker with static assets,
// not classic Cloudflare Pages).

import { json, requireAccess, rowToJson } from "./utils.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

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

    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

    // Anything that isn't an API route is a static asset (index.html, fonts, logo).
    return env.ASSETS.fetch(request);
  },
};

async function handleList(request, env) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

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
      JSON.stringify(Array.isArray(body.loc) ? body.loc : []),
      body.deal || null,
      body.rt || null,
      body.start || null,
      body.end || null,
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
    values.push(field === "deleted" ? (body[field] ? 1 : 0) : body[field]);
  }
  if ("loc" in body) {
    sets.push("loc = ?");
    values.push(JSON.stringify(Array.isArray(body.loc) ? body.loc : []));
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
        JSON.stringify(Array.isArray(r.loc) ? r.loc : []),
        r.deal || null,
        r.rt || null,
        r.start || null,
        r.end || null,
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
    `SELECT id, text, created_at FROM marketing_ideas ORDER BY created_at DESC`
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

async function handleIdeaDelete(request, env, id) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const result = await env.DB.prepare(`DELETE FROM marketing_ideas WHERE id = ?`).bind(id).run();
  if (!result.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true });
}

async function handleMarketingList(request, env) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const { results } = await env.DB.prepare(
    `SELECT id, name, date, end_date, type, status, notes
     FROM marketing_calendar
     ORDER BY date`
  ).all();
  return json(results);
}

async function handleMarketingCreate(request, env) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await request.json();
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return json({ error: "campaign name is required" }, 400);
  }
  if (!body.date) return json({ error: "date is required" }, 400);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO marketing_calendar (id, name, date, end_date, type, status, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(id, body.name.trim(), body.date, body.end_date || null, body.type || null, body.status || null, body.notes || null)
    .run();

  return json({ id }, 201);
}

async function handleMarketingPatch(request, env, id) {
  const email = requireAccess(request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await request.json();
  const colByField = { name: "name", date: "date", end_date: "end_date", type: "type", status: "status", notes: "notes" };

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
