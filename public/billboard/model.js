// Billboard Reporting: the numbers. Turns the raw rows from GET /api/billboard/campaigns/:id/data
// into the totals and breakdowns used by the tab and the PDF report.
// (Port of campaign_data.py from the local Python tool; same definitions, same results.)
//
//   Plays / time played    Navori ImpressionCount / TotalDuration for the campaign's artworks
//   Potential impressions  Datajam Impression totals, whole day, each JamBox counted once
//   Agreed plays           sum of each screen's weekly rate for the package, x days / 7
//                          (screens without a rate are left out of agreed AND delivered)

const toDate = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

export function buildModel(raw) {
  const { campaign, screens, start, end, plays, footfall } = raw;
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  const screenById = Object.fromEntries(screens.map((s) => [s.id, s]));
  const includeFootfall = !!campaign.include_footfall;

  // device|date -> whole-day impressions
  const daily = new Map();
  for (const f of footfall) daily.set(`${f.device}|${f.date}`, f.hours.reduce((a, b) => a + b, 0));

  const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  const impressions = (scr, ds) => {
    if (!includeFootfall) return null;
    const devices = [...new Set(scr.filter((s) => s.datajam_device).map((s) => s.datajam_device))];
    if (!devices.length) return null;
    let t = 0;
    for (const dev of devices) for (const d of ds) t += daily.get(`${dev}|${d}`) || 0;
    return t;
  };

  const m = {
    campaign, screens, start, end, days, includeFootfall, warnings: raw.warnings || [], fetchedAt: raw.fetched_at,
    isComplete: end >= campaign.end_date,

    totals() {
      return { plays: sum(plays, "plays"), airtime_s: sum(plays, "airtime_s"), impressions: impressions(screens, days),
        screens: screens.length, days: days.length };
    },

    byScreen() {
      return screens.map((s) => {
        const mine = plays.filter((p) => p.screen_id === s.id);
        return { screen: s.name, location: s.location, plays: sum(mine, "plays"), airtime_s: sum(mine, "airtime_s"),
          impressions: impressions([s], days) };
      });
    },

    // One row per artwork per screen: the "Content / Location" table.
    byArtworkScreen() {
      const order = Object.fromEntries(screens.map((s, i) => [s.id, i]));
      const t = new Map();
      for (const p of plays) {
        const k = `${p.artwork}\u0000${p.screen_id}`;
        const v = t.get(k) || { artwork: p.artwork, screen_id: p.screen_id, plays: 0, airtime_s: 0 };
        v.plays += p.plays; v.airtime_s += p.airtime_s;
        t.set(k, v);
      }
      return [...t.values()]
        .sort((a, b) => a.artwork.toLowerCase().localeCompare(b.artwork.toLowerCase()) || order[a.screen_id] - order[b.screen_id])
        .map((r) => ({ ...r, screen: screenById[r.screen_id].name, location: screenById[r.screen_id].location }));
    },

    impressionsByLocation() {
      if (!includeFootfall) return [];
      const groups = new Map();
      for (const s of screens) {
        if (!s.datajam_device) continue;
        if (!groups.has(s.datajam_device)) groups.set(s.datajam_device, []);
        groups.get(s.datajam_device).push(s);
      }
      return [...groups.entries()].map(([device, scr]) => ({
        device, location: scr[0].location || scr[0].name, screens: scr.map((s) => s.name),
        impressions: impressions(scr, days) || 0,
      })).sort((a, b) => b.impressions - a.impressions);
    },

    byDay() {
      return days.map((d) => {
        const mine = plays.filter((p) => p.date === d);
        return { date: d, plays: sum(mine, "plays"), airtime_s: sum(mine, "airtime_s"), impressions: impressions(screens, [d]) };
      });
    },

    byScreenDay() {
      const out = [];
      for (const s of screens) {
        for (const d of days) {
          const mine = plays.filter((p) => p.screen_id === s.id && p.date === d);
          out.push({ screen: s.name, location: s.location, date: d, plays: sum(mine, "plays"),
            airtime_s: sum(mine, "airtime_s"), impressions: impressions([s], [d]) });
        }
      }
      return out;
    },

    hourlyProfile() {
      const devices = new Set(screens.filter((s) => s.datajam_device).map((s) => s.datajam_device));
      const per = Array(24).fill(0);
      for (const f of footfall) if (devices.has(f.device)) f.hours.forEach((v, h) => { per[h] += v; });
      return per.map((v, h) => ({ hour: h, avg: v / (days.length || 1) }));
    },

    agreedVsDelivered() {
      const sov = campaign.share_of_voice;
      if (!sov) return null;
      const key = sov === "1/6" ? "agreed_week_1_6" : "agreed_week_1_18";
      const rated = screens.filter((s) => s[key]);
      if (!rated.length) return null;
      const delivered = new Map();
      for (const p of plays) delivered.set(p.screen_id, (delivered.get(p.screen_id) || 0) + p.plays);
      const groups = new Map();
      for (const s of rated) {
        const loc = s.location || s.name;
        if (!groups.has(loc)) groups.set(loc, []);
        groups.get(loc).push(s);
      }
      const locations = [...groups.entries()].map(([location, scr]) => {
        const weekly = scr.reduce((a, s) => a + s[key], 0);
        const agreed = weekly * days.length / 7;
        const del = scr.reduce((a, s) => a + (delivered.get(s.id) || 0), 0);
        return { location, screens: scr.map((s) => s.name), weekly, agreed, delivered: del, ratio: agreed ? del / agreed : null };
      });
      const weekly = locations.reduce((a, r) => a + r.weekly, 0);
      const agreed = locations.reduce((a, r) => a + r.agreed, 0);
      const del = locations.reduce((a, r) => a + r.delivered, 0);
      return { package: sov, weekly, agreed, delivered: del, ratio: agreed ? del / agreed : null,
        missing: screens.filter((s) => !s[key]).map((s) => s.name), locations, key };
    },
  };
  return m;
}

// ------------------------------------------------------------------ formatting
export const fmtInt = (v) => (v === null || v === undefined ? "–" : Math.round(v).toLocaleString("en-GB"));

export function fmtHMS(seconds) {   // '22h 58m 47s' (table rows), like the existing report
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}h ${p(m)}m ${p(sec)}s` : `${m}m ${p(sec)}s`;
}

export function fmtHM(seconds) {    // '68h 30m' (tiles)
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h.toLocaleString("en-GB")}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const MONTHS = MONTHS_LONG.map((x) => x.slice(0, 3));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function niceDate(s, { year = true, dow = false } = {}) {
  const d = toDate(s);
  return `${dow ? DOW[d.getUTCDay()] + " " : ""}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? " " + d.getUTCFullYear() : ""}`;
}

export function longDate(s) {   // '30 November 2026'
  const d = toDate(s);
  return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function periodParts(a, b) {   // {dates: 'October 24 - October 31', year: '2026'}
  const da = toDate(a), db = toDate(b);
  const md = (d) => `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return {
    dates: a === b ? md(da) : `${md(da)} - ${md(db)}`,
    year: da.getUTCFullYear() === db.getUTCFullYear() ? String(da.getUTCFullYear()) : `${da.getUTCFullYear()} - ${db.getUTCFullYear()}`,
  };
}

export function versusText(ratio) {
  if (ratio === null || ratio === undefined) return "";
  return ratio >= 1 ? `+${Math.round((ratio - 1) * 100)}% above agreed` : `${Math.round(ratio * 100)}% of agreed`;
}

export function reportBasename(model) {
  const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
  return `${slug(model.campaign.client_name)}_Campaign-Report_${model.start}_to_${model.end}${model.isComplete ? "" : "_interim"}`;
}

// ------------------------------------------------------------------ CSV
const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

export function summaryCsv(model) {
  const sov = model.campaign.share_of_voice;
  const key = sov === "1/6" ? "agreed_week_1_6" : "agreed_week_1_18";
  const rate = Object.fromEntries(model.screens.map((s) => [s.name, sov ? s[key] : null]));
  const head = ["client", "screen", "location", "date"];
  if (sov) head.push(`agreed_plays_${sov.replace("/", "_")}`);
  head.push("delivered_plays", "time_played_seconds");
  if (model.includeFootfall) head.push("potential_impressions");
  const rows = [head];
  for (const r of model.byScreenDay()) {
    const row = [model.campaign.client_name, r.screen, r.location, r.date];
    if (sov) row.push(rate[r.screen] ? Math.round((rate[r.screen] / 7) * 10) / 10 : "");
    row.push(r.plays, Math.round(r.airtime_s));
    if (model.includeFootfall) row.push(r.impressions === null ? "" : Math.round(r.impressions));
    rows.push(row);
  }
  return toCsv(rows);
}

export function playsCsv(raw) {
  const names = Object.fromEntries(raw.screens.map((s) => [s.id, s.name]));
  return toCsv([["screen", "date", "artwork", "plays", "time_played_seconds"],
    ...raw.plays.map((p) => [names[p.screen_id], p.date, p.artwork, p.plays, Math.round(p.airtime_s)])]);
}

export function footfallCsv(raw) {
  return toCsv([["jambox", "date", "hour", "impressions"],
    ...raw.footfall.flatMap((f) => f.hours.map((v, h) => [f.device, f.date, h, v]))]);
}

export function download(filename, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
