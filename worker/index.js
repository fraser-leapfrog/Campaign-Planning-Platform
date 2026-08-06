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
