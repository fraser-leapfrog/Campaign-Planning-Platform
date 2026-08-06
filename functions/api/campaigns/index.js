import { json, requireAccess, rowToJson } from "../../_utils.js";

// GET /api/campaigns — list every row (including archived; the front-end filters).
export async function onRequestGet(context) {
  const email = requireAccess(context.request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const { results } = await context.env.DB.prepare(
    `SELECT id, name AS n, status AS s, loc, deal, retarget AS rt,
            start_date AS "start", end_date AS "end", notes, rotation, deleted
     FROM campaigns
     ORDER BY (start_date IS NULL), start_date`
  ).all();

  return json(results.map(rowToJson));
}

// POST /api/campaigns — create one row. Body: { n, s, loc, deal, rt, start, end, notes, rotation }
export async function onRequestPost(context) {
  const email = requireAccess(context.request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await context.request.json();
  if (!body || typeof body.n !== "string" || !body.n.trim()) {
    return json({ error: "campaign name is required" }, 400);
  }

  const id = crypto.randomUUID();
  await context.env.DB.prepare(
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
