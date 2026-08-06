import { json, requireAccess } from "../../_utils.js";

// PATCH /api/campaigns/:id — partial update. Also used for archive ({deleted:true})
// and restore ({deleted:false}) so the client only needs one verb for all edits.
export async function onRequestPatch(context) {
  const email = requireAccess(context.request);
  if (!email) return json({ error: "unauthorized" }, 401);

  const id = context.params.id;
  const body = await context.request.json();

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

  const result = await context.env.DB.prepare(
    `UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...values)
    .run();

  if (!result.meta.changes) return json({ error: "not found" }, 404);
  return json({ ok: true });
}
