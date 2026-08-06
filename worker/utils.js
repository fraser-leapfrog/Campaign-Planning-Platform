// Shared helpers for the Worker's API routes.

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Cloudflare Access sits in front of the whole app (see README), so every request
// reaching the Worker should already carry this header. Checking it here too is
// defense-in-depth in case Access is ever misconfigured for a sub-path.
export function requireAccess(request) {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (!email) return null;
  return email;
}

export function rowToJson(row) {
  return {
    id: row.id,
    n: row.n,
    s: row.s,
    loc: row.loc ? JSON.parse(row.loc) : [],
    deal: row.deal,
    rt: row.rt,
    start: row.start,
    end: row.end,
    notes: row.notes,
    rotation: row.rotation,
    deleted: !!row.deleted,
  };
}
