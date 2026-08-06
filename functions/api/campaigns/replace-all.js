import { json, requireAccess } from "../../_utils.js";

// POST /api/campaigns/replace-all — bulk-replace every row, used by "Import backup".
// Body: { rows: [...] }. Wipes the table and re-inserts atomically via D1 batch().
export async function onRequestPost(context) {
  const email = requireAccess(context.request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const body = await context.request.json();
  const rows = Array.isArray(body.rows) ? body.rows : [];

  const stmts = [context.env.DB.prepare("DELETE FROM campaigns")];
  for (const r of rows) {
    if (!r || typeof r.n !== "string") continue;
    stmts.push(
      context.env.DB.prepare(
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

  await context.env.DB.batch(stmts);
  return json({ ok: true, count: stmts.length - 1 });
}
