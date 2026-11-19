// Client results page: password sign-in, then a live dashboard built from the stored numbers
// (GET /client/api/<token>). Uses the same maths as the PDF report (billboard/model.js), served
// via /client/lib so nothing else in the app is reachable from here.

import { buildModel, fmtInt, fmtHM, niceDate } from "./lib/model.js";
import { columnChart } from "./lib/charts.js";

// leapfrogadvertising.com/reports/<slug> (what clients get) or /client/<slug> (The Pond preview).
const [, base, token] = location.pathname.match(/^\/(reports|client)\/([\w-]{4,64})$/) || [];
const API = `/${base}/api/${token}`;
const RELOAD_MS = 10 * 60e3;   // the numbers change about hourly; re-read the stored copy every 10 minutes

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let data = null;

function ago(isoTime) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(isoTime)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

function notice(title, text) {
  $("app").innerHTML = `<div class="notice"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`;
  $("top-right").innerHTML = "";
}

// ------------------------------------------------------------------ load / sign in
async function load() {
  if (!token) { notice("Link not found", "Please check the link you were sent."); return; }
  let res;
  try {
    res = await fetch(API, { cache: "no-store", credentials: "same-origin" });
  } catch (_) {
    if (!data) notice("Can't connect", "Please check your internet connection and try again.");
    return;
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { data = null; signIn(); return; }
  if (!res.ok) { data = null; notice("This link isn't active", body.error || "Please ask Leapfrog Advertising for a new link."); return; }
  const same = data && data.fetched_at === body.fetched_at && data.status === body.status && data.today === body.today;
  data = body;
  if (same) {   // nothing new: just refresh the "Updated … ago" line, don't redraw (keeps the scroll position)
    const upd = $("top-right").querySelector("div");
    if (upd && data.fetched_at) upd.textContent = `Updated ${ago(data.fetched_at)}`;
    return;
  }
  render();
}

function signIn(error = "") {
  $("foot").hidden = true;
  $("top-right").innerHTML = "";
  $("app").innerHTML = `
    <form class="signin" id="signin" autocomplete="on">
      <h1>Campaign results</h1>
      <p>Enter the password Leapfrog Advertising sent you to see your live results.</p>
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus />
      <button class="btn" type="submit" id="pw-go">View results</button>
      <div class="err" id="pw-err" role="alert">${esc(error)}</div>
    </form>`;
  $("signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("pw-go");
    btn.disabled = true; btn.textContent = "Checking…"; $("pw-err").textContent = "";
    try {
      const res = await fetch(`${API}/login`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: $("pw").value }), credentials: "same-origin" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Something went wrong. Please try again.");
      await load();
    } catch (err) {
      btn.disabled = false; btn.textContent = "View results";
      $("pw-err").textContent = err.message;
      $("pw").select();
    }
  });
}

$("sign-out").addEventListener("click", async () => {
  try { await fetch(`${API}/logout`, { method: "POST", credentials: "same-origin" }); } catch (_) { /* ignore */ }
  data = null;
  signIn();
});

// ------------------------------------------------------------------ dashboard
function render() {
  const d = data;
  document.title = `${d.client_name} · Campaign results · Leapfrog Advertising`;
  $("foot").hidden = false;
  const totalDays = daysBetween(d.start_date, d.end_date) + 1;
  const range = `${niceDate(d.start_date, { year: d.start_date.slice(0, 4) !== d.end_date.slice(0, 4) })} – ${niceDate(d.end_date)}`;
  const pill = d.status === "live" ? `<span class="pill live">Live</span>`
    : d.status === "complete" ? `<span class="pill final">Final results</span>` : `<span class="pill soon">Starting soon</span>`;
  $("top-right").innerHTML = `${pill}${d.fetched_at && d.status !== "upcoming"
    ? `<div style="margin-top:4px">Updated ${esc(ago(d.fetched_at))}</div>` : ""}`;

  const dayNo = Math.min(Math.max(daysBetween(d.start_date, d.today) + 1, 0), totalDays);
  const progress = d.status === "upcoming"
    ? `<div class="progress"><div class="lbl" style="margin-top:0"><span>Starts ${esc(niceDate(d.start_date, { dow: true }))}</span>
        <span>${totalDays} days</span></div></div>`
    : `<div class="progress"><div class="bar"><i style="width:${(100 * dayNo / totalDays).toFixed(1)}%"></i></div>
        <div class="lbl"><span>${d.status === "complete" ? "Campaign complete" : `Day ${dayNo} of ${totalDays}`}</span>
        <span>${d.status === "complete" ? `${totalDays} days` : `${totalDays - dayNo} to go`}</span></div></div>`;
  const hero = `<section class="hero">
      <p class="eyebrow">${d.status === "complete" ? "Final campaign results" : "Live campaign results"}</p>
      <h1>${esc(d.client_name)}</h1>
      <p class="dates">${esc(range)}</p>${progress}</section>`;
  const photo = d.has_photo ? `<div class="hero-photo"><img src="${API}/photo" alt="Your campaign on screen" loading="lazy"></div>` : "";

  if (d.status === "upcoming") {
    $("app").innerHTML = `${hero}${photo}<div class="card"><h2>Starting soon</h2>
      <p class="sub" style="margin:6px 0 4px">Your campaign goes live on ${esc(niceDate(d.start_date, { dow: true }))}. Live results
        appear here from the first day and update about every hour.</p></div>`;
    return;
  }
  if (d.pending) {
    $("app").innerHTML = `${hero}${photo}<div class="card"><h2>Your first numbers are on their way</h2>
      <p class="sub" style="margin:6px 0 4px">Results update about every hour. Please check back shortly.</p></div>`;
    return;
  }

  const campaign = { client_name: d.client_name, start_date: d.start_date, end_date: d.end_date, include_footfall: d.include_footfall };
  const m = buildModel({ campaign, screens: d.screens, start: d.start_date, end: d.through, plays: d.plays, footfall: d.footfall });
  const t = m.totals();
  const days = m.byDay();
  const partial = d.partial_date && days.length && days[days.length - 1].date === d.partial_date;
  const today = partial ? days[days.length - 1] : null;
  const footfall = d.include_footfall && t.impressions !== null;

  // Averages and the hourly pattern use complete days only (today is still counting).
  const completeEnd = partial ? addDays(d.through, -1) : d.through;
  const completeDays = days.filter((x) => x.date <= completeEnd);
  const avgPlays = completeDays.length ? completeDays.reduce((a, x) => a + x.plays, 0) / completeDays.length : null;

  const tiles = [`<div class="tile feature"><div class="v">${fmtInt(t.plays)}</div><div class="l">Plays</div>
      ${avgPlays !== null ? `<div class="s">${fmtInt(avgPlays)} a day on average</div>` : ""}
      ${d.agreed_pct ? `<span class="badge">+${d.agreed_pct}% above agreed</span>` : ""}</div>`,
    `<div class="tile"><div class="v">${fmtHM(t.airtime_s)}</div><div class="l">Time on screen</div>
      <div class="s">across ${m.screens.length} screen${m.screens.length === 1 ? "" : "s"}</div></div>`];
  if (footfall) {
    tiles.push(`<div class="tile"><div class="v">${fmtInt(t.impressions)}</div><div class="l">Potential impressions</div>
      <div class="s">based on footfall by each placement</div></div>`);
  }
  if (today) {
    tiles.push(`<div class="tile"><div class="v">${fmtInt(today.plays)}</div><div class="l">Plays today so far</div>
      ${footfall ? `<div class="s">${fmtInt(today.impressions)} potential impressions so far</div>` : ""}</div>`);
  }

  // Charts are drawn at the card's real width so the labels stay readable on phones.
  const dailyCards = `<div class="${footfall ? "grid2" : ""}">
      <div class="card"><h2>Plays per day</h2><p class="sub">Every time your advert played</p><div class="chart" id="ch-plays"></div>
        ${partial ? `<div class="key"><span><i style="background:#510780"></i>Full day</span><span><i style="background:#c4a1e0"></i>Today so far</span></div>` : ""}</div>
      ${footfall ? `<div class="card"><h2>Potential impressions per day</h2><p class="sub">Based on footfall by each placement</p><div class="chart" id="ch-imps"></div>
        ${partial ? `<div class="key"><span><i style="background:#510780"></i>Full day</span><span><i style="background:#c4a1e0"></i>Today so far</span></div>` : ""}</div>` : ""}
    </div>`;
  const hourlyCard = footfall && completeDays.length ? `<div class="card"><h2>When people pass your screens</h2>
      <p class="sub">Average potential impressions per hour of the day, over ${completeDays.length} full day${completeDays.length === 1 ? "" : "s"}</p>
      <div class="chart" id="ch-hours"></div></div>` : "";

  const byScreen = m.byScreen();
  const screenTable = `<div class="card"><h2>By screen</h2><p class="sub">Where your advert played</p><div class="table-wrap"><table>
      <thead><tr><th>Screen</th><th class="n">Plays</th><th class="n">Time on screen</th></tr></thead><tbody>
      ${byScreen.map((r) => `<tr><td class="name">${esc(r.screen)}${r.location && r.location !== r.screen ? `<span class="small">${esc(r.location)}</span>` : ""}</td>
        <td class="n">${fmtInt(r.plays)}</td><td class="n">${fmtHM(r.airtime_s)}</td></tr>`).join("")}
      </tbody></table></div></div>`;

  const art = new Map();
  for (const r of m.byArtworkScreen()) {
    const a = art.get(r.artwork) || { artwork: r.artwork, plays: 0, airtime_s: 0 };
    a.plays += r.plays; a.airtime_s += r.airtime_s;
    art.set(r.artwork, a);
  }
  const artRows = [...art.values()].sort((a, b) => b.plays - a.plays);
  const artTable = artRows.length ? `<div class="card"><h2>By artwork</h2><p class="sub">Each version of your advert</p><div class="table-wrap"><table>
      <thead><tr><th>Artwork</th><th class="n">Plays</th><th class="n">Time on screen</th></tr></thead><tbody>
      ${artRows.map((r) => `<tr><td class="name">${esc(r.artwork)}</td><td class="n">${fmtInt(r.plays)}</td><td class="n">${fmtHM(r.airtime_s)}</td></tr>`).join("")}
      </tbody></table></div></div>` : "";

  $("app").innerHTML = `${hero}${photo}<div class="tiles">${tiles.join("")}</div>${dailyCards}${hourlyCard}${screenTable}${artTable}`;

  drawCharts = () => {
    const labels = days.map((x) => niceDate(x.date, { year: false }));
    const draw = (id, values, title) => {
      const el = $(id);
      if (!el) return;
      const width = Math.max(260, Math.round(el.clientWidth));
      const axisFont = width < 420 ? 11 : 12;
      const labelEvery = Math.max(1, Math.ceil(values.length / Math.max(3, Math.floor(width / 70))));
      el.innerHTML = columnChart(labels, values, { width, height: width < 420 ? 220 : 250, labelEvery, axisFont, title,
        partialIndex: partial ? values.length - 1 : -1 });
    };
    draw("ch-plays", days.map((x) => x.plays), "Plays per day");
    if (footfall) draw("ch-imps", days.map((x) => x.impressions || 0), "Potential impressions per day");
    const hoursEl = $("ch-hours");
    if (hoursEl) {
      const cm = buildModel({ campaign, screens: d.screens, start: d.start_date, end: completeEnd, plays: [],
        footfall: d.footfall.filter((f) => f.date <= completeEnd) });
      const hourly = cm.hourlyProfile();
      const width = Math.max(260, Math.round(hoursEl.clientWidth));
      hoursEl.innerHTML = columnChart(hourly.map((h) => String(h.hour).padStart(2, "0")), hourly.map((h) => h.avg),
        { width, height: width < 420 ? 220 : 250, labelEvery: width < 520 ? 4 : 2, axisFont: width < 420 ? 11 : 12,
          title: "Average potential impressions per hour" });
    }
  };
  drawCharts();
}

let drawCharts = () => {};
let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => drawCharts(), 150); });

load();
setInterval(() => { if (data && document.visibilityState === "visible") load(); }, RELOAD_MS);
document.addEventListener("visibilitychange", () => { if (data && document.visibilityState === "visible") load(); });
