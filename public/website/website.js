// Website tab → Analytics: visits, page views, acquisition channels and sources for
// leapfrogadvertising.com, and where every enquiry / guide download came from.
// Data: GET /api/website/summary?days=N (worker/website.js). Loaded as a module by index.html;
// the page tab handler calls window.Website.show() when the tab is opened.

import { niceTicks, fmtNum } from "../billboard/charts.js";

const RANGES = [["7", "Last 7 days"], ["14", "Last 14 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last 12 months"]];
// Over-time series. Colours are CSS vars (website.css, light + dark steps validated for colour-blind separation).
const METRICS = [["views", "Page views"], ["sessions", "Visits"], ["visitors", "Visitors"], ["conversions", "Conversions"]];
const METRIC_COLOUR = { views: "var(--web-s1)", sessions: "var(--web-s2)", visitors: "var(--web-s3)", conversions: "var(--web-s4)" };
const CHANNEL_COLOURS = {
  "Paid Search": "#e43f84", "Organic Search": "#7209b7", "Direct": "#8b7797", "Referral": "#3a86c8",
  "Organic Social": "#2a9d8f", "Paid Social": "#f08a24", "Email": "#d9ad3c", "QR & Offline": "#510780",
  "AI Assistants": "#5b5fd6", "Display": "#c2410c", "Paid Other": "#be185d", "Other Campaigns": "#6b7280",
};
const FORM_LABEL = { enquiry: "Enquiry", guide: "Guide download" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);
const int = (n) => Math.round(n || 0).toLocaleString("en-GB");
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(a / b < 0.1 ? 1 : 0)}%` : "–");
const dot = (ch) => `<span class="web-dot" style="background:${CHANNEL_COLOURS[ch] || "#9ca3af"}"></span>`;
let countryNames = null;
try { countryNames = new Intl.DisplayNames(["en-GB"], { type: "region" }); } catch (_) {}
const country = (c) => { try { return c && c !== "??" && countryNames ? countryNames.of(c) : "Unknown"; } catch (_) { return c; } };
const dayLabel = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayLong = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const when = (ms) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

// days: a RANGES preset, or "custom" (then from/to, YYYY-MM-DD, are sent instead)
const state = { days: "30", from: null, to: null, lines: new Set(["views", "sessions", "visitors"]),
  data: null, loading: false, error: null, form: "all", channel: null };

// ----------------------------------------------------------------------------- entry
let shown = false;
export async function show() {
  if (!shown) {
    shown = true;
    $("web-analytics").addEventListener("click", onClick);
    $("web-analytics").addEventListener("change", onChange);
  }
  await load();
}

async function load() {
  state.loading = true; state.error = null; render();
  try {
    const q = state.days === "custom" && state.from && state.to
      ? `from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}` : `days=${state.days}`;
    const res = await fetch(`/api/website/summary?${q}`, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    state.data = data;
  } catch (e) { state.error = e.message; }
  state.loading = false; render();
}

function onClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (act === "line") {
    const k = t.dataset.v;
    if (state.lines.has(k)) { if (state.lines.size > 1) state.lines.delete(k); } else state.lines.add(k);
    render();
  }
  else if (act === "refresh") load();
  else if (act === "form") { state.form = t.dataset.v; render(); }
  else if (act === "channel") { state.channel = state.channel === t.dataset.v ? null : t.dataset.v; render(); if (state.channel) $("web-conv").scrollIntoView({ behavior: "smooth", block: "start" }); }
  else if (act === "clear-channel") { state.channel = null; render(); }
  else if (act === "csv") downloadCsv();
}

function onChange(e) {
  const t = e.target;
  if (t.id === "web-preset") {
    if (t.value === "custom") { // keep the dates on screen, just unlock them as a custom range
      state.days = "custom"; state.from = state.data?.from || null; state.to = state.data?.to || null; render();
      $("web-from")?.focus();
    } else { state.days = t.value; load(); }
  } else if (t.id === "web-from" || t.id === "web-to") {
    const from = $("web-from").value, to = $("web-to").value;
    if (!from || !to) return;
    state.days = "custom";
    [state.from, state.to] = from <= to ? [from, to] : [to, from];
    load();
  }
}

// ----------------------------------------------------------------------------- render
function render() {
  const root = $("web-analytics");
  const d = state.data;
  const chips = (act, list, cur) => list.map(([v, l]) =>
    `<button type="button" class="chip range-chip" data-act="${act}" data-v="${v}" aria-pressed="${v === cur}">${l}</button>`).join("");
  const from = state.days === "custom" ? state.from : d?.from, to = state.days === "custom" ? state.to : d?.to;
  const today = d?.today || new Date().toISOString().slice(0, 10);
  let html = `<div class="range-row">
      <div class="date-control web-dates" role="group" aria-label="Date range">
        <label for="web-preset">Dates</label>
        <select id="web-preset">${RANGES.concat([["custom", "Custom range"]]).map(([v, l]) =>
          `<option value="${v}"${v === state.days ? " selected" : ""}>${l}</option>`).join("")}</select>
        <span class="date-range">
          <input type="date" id="web-from" aria-label="From" value="${esc(from || "")}" max="${esc(today)}">
          <span class="arrow" aria-hidden="true">→</span>
          <input type="date" id="web-to" aria-label="To" value="${esc(to || "")}" max="${esc(today)}">
        </span>
      </div>
      <button type="button" class="btn btn-ghost web-refresh" data-act="refresh"${state.loading ? " disabled" : ""}>${state.loading ? "Loading…" : "Refresh"}</button>
    </div>`;
  if (state.error) html += `<div class="web-banner">Couldn't load website analytics: ${esc(state.error)}</div>`;
  if (!d) { root.innerHTML = html + (state.loading ? `<div class="web-empty">Loading…</div>` : ""); return; }

  const T = d.totals, P = d.previous;
  html += `<div class="${state.loading ? "web-stale" : ""}">`;
  if (!d.first_data) {
    html += `<div class="web-banner">No visits recorded yet. Tracking starts as soon as the website update is live; check back after a few visits.</div>`;
  } else if (d.first_data > d.since) {
    html += `<p class="web-note">Tracking began ${esc(when(d.first_data))}, so this window is shorter than it looks. Google Analytics has the history before then.</p>`;
  }

  html += `<div class="web-kpis">
    ${kpi("Visitors", T.visitors, P.visitors)}
    ${kpi("Visits", T.sessions, P.sessions)}
    ${kpi("Page views", T.pageviews, P.pageviews)}
    ${kpi("Conversions", T.conversions, P.conversions, `${int(T.enquiries)} enquir${T.enquiries === 1 ? "y" : "ies"} · ${int(T.guides)} guide download${T.guides === 1 ? "" : "s"}`)}
    <div class="web-kpi"><div class="v">${pct(T.conversions, T.sessions)}</div><div class="l">Conversion rate</div><div class="s">of visits ended in an enquiry or download</div></div>
  </div>`;

  // Over time: one line per chosen metric; hover (or arrow keys) shows every metric for that day
  html += `<div class="chart-card web-card">
    <div class="chart-card-head"><h2>Over time</h2>
      <div class="chip-group" role="group" aria-label="Lines shown">${METRICS.map(([k, l]) =>
        `<button type="button" class="chip web-line-chip" data-act="line" data-v="${k}" aria-pressed="${state.lines.has(k)}">
          <span class="web-key" style="background:${METRIC_COLOUR[k]}"></span>${l}</button>`).join("")}</div></div>
    ${lineChart(d)}
  </div>`;

  // Acquisition
  const maxCh = Math.max(1, ...d.channels.map((c) => c.sessions));
  html += `<div class="web-grid">
    <div class="chart-card web-card">
      <div class="chart-card-head"><h2>Acquisition channels</h2><span class="web-hint">Click a channel to see its conversions</span></div>
      ${table(["Channel", "Visits", "", "Conversions", "Conv. rate"], d.channels.map((c) => `
        <tr class="web-click${state.channel === c.channel ? " on" : ""}" data-act="channel" data-v="${esc(c.channel)}">
          <td class="nowrap">${dot(c.channel)}${esc(c.channel)}</td><td class="num">${int(c.sessions)}</td>
          <td class="web-barcell"><span class="web-bar" style="width:${(c.sessions / maxCh) * 100}%;background:${CHANNEL_COLOURS[c.channel] || "#9ca3af"}"></span></td>
          <td class="num">${int(c.conversions)}</td><td class="num">${pct(c.conversions, c.sessions)}</td></tr>`), "No visits in this window.")}
    </div>
    <div class="chart-card web-card">
      <div class="chart-card-head"><h2>Sources</h2><span class="web-hint">source / medium</span></div>
      ${table(["Source / medium", "Visits", "Conversions"], d.sources.map((s) => `
        <tr><td>${esc(s.source)} <span class="web-muted">/ ${esc(s.medium)}</span></td><td class="num">${int(s.sessions)}</td><td class="num">${int(s.conversions)}</td></tr>`), "No visits in this window.")}
    </div>
  </div>`;

  // Pages
  html += `<div class="web-grid">
    <div class="chart-card web-card">
      <div class="chart-card-head"><h2>Top pages</h2></div>
      ${table(["Page", "Views", "Visits"], d.pages.map((p) => `<tr><td class="web-path">${esc(p.path)}</td><td class="num">${int(p.views)}</td><td class="num">${int(p.sessions)}</td></tr>`), "No page views in this window.")}
    </div>
    <div class="chart-card web-card">
      <div class="chart-card-head"><h2>Landing pages</h2><span class="web-hint">first page of each visit</span></div>
      ${table(["Page", "Visits", "Conversions"], d.landings.map((p) => `<tr><td class="web-path">${esc(p.path)}</td><td class="num">${int(p.sessions)}</td><td class="num">${int(p.conversions)}</td></tr>`), "No visits in this window.")}
    </div>
  </div>`;

  // Campaigns, devices, countries
  html += `<div class="web-grid web-grid-3">
    <div class="chart-card web-card">
      <div class="chart-card-head"><h2>Campaigns</h2><span class="web-hint">utm_campaign</span></div>
      ${table(["Campaign", "Visits", "Conv."], d.campaigns.map((c) => `<tr><td>${esc(c.campaign)}</td><td class="num">${int(c.sessions)}</td><td class="num">${int(c.conversions)}</td></tr>`),
        "None yet. Add <code>?utm_campaign=…</code> to ad, email and QR links to see them here.")}
    </div>
    <div class="chart-card web-card">
      <div class="chart-card-head"><h2>Devices</h2></div>
      ${table(["Device", "Visits", "Conv."], d.devices.map((x) => `<tr><td>${esc(x.device)}</td><td class="num">${int(x.sessions)}</td><td class="num">${int(x.conversions)}</td></tr>`), "–")}
    </div>
    <div class="chart-card web-card">
      <div class="chart-card-head"><h2>Countries</h2></div>
      ${table(["Country", "Visits"], d.countries.map((x) => `<tr><td>${esc(country(x.country))}</td><td class="num">${int(x.sessions)}</td></tr>`), "–")}
    </div>
  </div>`;

  // Conversions
  let conv = d.conversions;
  if (state.form !== "all") conv = conv.filter((c) => (state.form === "guide") === (c.form === "guide"));
  if (state.channel) conv = conv.filter((c) => (c.channel || "Direct") === state.channel);
  html += `<div class="chart-card web-card" id="web-conv">
    <div class="chart-card-head"><h2>Conversions: where each one came from</h2>
      <div class="web-conv-tools">
        <div class="chip-group">${chips("form", [["all", "All"], ["enquiry", "Enquiries"], ["guide", "Guide downloads"]], state.form)}</div>
        ${state.channel ? `<button type="button" class="chip" data-act="clear-channel" aria-pressed="true">${dot(state.channel)}${esc(state.channel)} ✕</button>` : ""}
        <button type="button" class="btn btn-ghost" data-act="csv"${conv.length ? "" : " disabled"}>Download CSV</button>
      </div>
    </div>
    ${table(["When", "Type", "Who", "Came from", "Campaign", "Landed on", "Converted on", "Answers"], conv.map((c) => `
      <tr><td class="nowrap">${esc(when(c.ts))}</td>
        <td><span class="web-form ${c.form === "guide" ? "guide" : ""}">${FORM_LABEL[c.form] || esc(c.form)}</span></td>
        <td>${c.name || c.company ? `${esc(c.name || "")}${c.company ? `<div class="web-muted">${esc(c.company)}</div>` : ""}` : `<span class="web-muted">${c.form === "guide" ? "In HubSpot" : "–"}</span>`}</td>
        <td>${dot(c.channel || "Direct")}${esc(c.channel || "Direct")}<div class="web-muted">${esc(c.source || "")} / ${esc(c.medium || "")}</div></td>
        <td>${esc(c.campaign || "–")}</td>
        <td class="web-path">${esc(c.landing || "–")}${c.referrer ? `<div class="web-muted">via ${esc(c.referrer)}</div>` : ""}</td>
        <td class="web-path">${esc(c.page || "–")}</td>
        <td>${[c.campaign_type, c.area].filter(Boolean).map(esc).join("<br>") || "–"}</td></tr>`),
      state.channel || state.form !== "all" ? "No conversions match this filter." : "No enquiries or guide downloads in this window yet.")}
  </div>
  </div>
  <p class="web-note">How this is counted: every visit to leapfrogadvertising.com is recorded without cookies or anything stored on the
    visitor's device, so it includes people who decline the cookie banner (Google Analytics only sees those who accept).
    A visit ends after 30 minutes of inactivity. Visitors are counted per day. Each conversion is credited to the source of the
    visit it happened in: Google Ads clicks, UTM-tagged links (e.g. QR codes on billboards), search engines, social sites, other websites, or Direct.</p>`;
  root.innerHTML = html;
  wireLineChart(d);
}

// ----------------------------------------------------------------------------- over-time line chart
const LC = { W: 900, H: 260, ML: 46, MR: 92, MT: 14, MB: 30 };

function lineGeom(d) {
  const keys = METRICS.map((m) => m[0]).filter((k) => state.lines.has(k));
  const n = d.daily.length;
  const plotW = LC.W - LC.ML - LC.MR, plotH = LC.H - LC.MT - LC.MB;
  const ticks = niceTicks(Math.max(1, ...d.daily.flatMap((x) => keys.map((k) => x[k]))));
  const yMax = ticks[ticks.length - 1];
  const xAt = (i) => LC.ML + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const yAt = (v) => LC.MT + plotH - (v / yMax) * plotH;
  return { keys, n, plotW, plotH, ticks, yMax, xAt, yAt };
}

function lineChart(d) {
  const { keys, n, ticks, xAt, yAt, plotH } = lineGeom(d);
  const label = METRICS.filter((m) => keys.includes(m[0])).map((m) => m[1]).join(", ") + " per day";
  let svg = "";
  for (const t of ticks) {
    const y = yAt(t).toFixed(1);
    svg += `<line x1="${LC.ML}" x2="${LC.W - LC.MR}" y1="${y}" y2="${y}" class="${t === 0 ? "web-base" : "web-grid-line"}"/>`;
    svg += `<text x="${LC.ML - 8}" y="${(+y + 4).toFixed(1)}" text-anchor="end" class="web-axis">${fmtNum(t)}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / 8));
  d.daily.forEach((x, i) => {
    if (i % every === 0 || (i === n - 1 && (n - 1) % every > every / 2)) {
      svg += `<text x="${xAt(i).toFixed(1)}" y="${LC.MT + plotH + 20}" text-anchor="middle" class="web-axis">${esc(dayLabel(x.day))}</text>`;
    }
  });
  // Lines (single points get a dot so a 1-day range still shows something)
  const ends = [];
  for (const k of keys) {
    const pts = d.daily.map((x, i) => `${xAt(i).toFixed(1)},${yAt(x[k]).toFixed(1)}`);
    svg += n > 1 ? `<polyline points="${pts.join(" ")}" fill="none" stroke="${METRIC_COLOUR[k]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
      : `<circle cx="${xAt(0)}" cy="${yAt(d.daily[0][k])}" r="4" fill="${METRIC_COLOUR[k]}"/>`;
    ends.push({ k, y: yAt(d.daily[n - 1][k]) });
  }
  // Direct labels at the right end, nudged apart so they never overlap
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 14);
  const over = ends.length ? ends[ends.length - 1].y - (LC.MT + plotH) : 0;
  if (over > 0) ends.forEach((e) => (e.y -= over));
  for (const e of ends) {
    svg += `<text x="${LC.W - LC.MR + 8}" y="${(e.y + 4).toFixed(1)}" class="web-end">${METRICS.find((m) => m[0] === e.k)[1]}</text>`;
  }
  // Hover layer: crosshair + a ringed dot per line, positioned by wireLineChart()
  svg += `<g class="web-cross" opacity="0"><line y1="${LC.MT}" y2="${LC.MT + plotH}"/>${keys.map((k) =>
    `<circle r="4.5" data-k="${k}" fill="${METRIC_COLOUR[k]}" stroke="var(--surface)" stroke-width="2"/>`).join("")}</g>`;
  return `<div class="web-line" id="web-line" tabindex="0" aria-label="${esc(label)}. Hover or use the arrow keys to read each day's numbers.">
    <svg viewBox="0 0 ${LC.W} ${LC.H}" role="img" aria-label="${esc(label)}">${svg}</svg>
    <div class="web-tip" role="status" aria-live="polite"></div>
  </div>`;
}

function wireLineChart(d) {
  const box = $("web-line");
  if (!box || !d.daily.length) return;
  const svg = box.querySelector("svg"), tip = box.querySelector(".web-tip"), cross = box.querySelector(".web-cross");
  const { keys, n, plotW, xAt, yAt } = lineGeom(d);
  let cur = -1;
  const show = (i) => {
    cur = i = Math.max(0, Math.min(n - 1, i));
    const x = d.daily[i], px = xAt(i);
    cross.setAttribute("opacity", "1");
    const ln = cross.querySelector("line"); ln.setAttribute("x1", px); ln.setAttribute("x2", px);
    cross.querySelectorAll("circle").forEach((c) => { c.setAttribute("cx", px); c.setAttribute("cy", yAt(x[c.dataset.k])); });
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "web-tip-date";
    head.textContent = dayLong(x.day) + (x.day === d.today ? " (so far)" : "");
    tip.append(head);
    for (const [k, l] of METRICS) {
      const row = document.createElement("div");
      row.className = "web-tip-row" + (keys.includes(k) ? "" : " off");
      const key = document.createElement("span"); key.className = "web-tip-key"; key.style.background = METRIC_COLOUR[k];
      const v = document.createElement("b"); v.textContent = int(x[k]);
      const name = document.createElement("span"); name.textContent = l;
      row.append(key, v, name);
      tip.append(row);
    }
    if (x.sessions) {
      const r = document.createElement("div"); r.className = "web-tip-foot";
      r.textContent = `${(x.views / x.sessions).toFixed(1)} pages per visit`;
      tip.append(r);
    }
    // Keep the tooltip inside the card: flip to the left of the crosshair past the midpoint
    const frac = px / LC.W;
    tip.style.left = `${frac * 100}%`;
    tip.classList.toggle("flip", frac > 0.55);
    tip.classList.add("show");
  };
  const hide = () => { cross.setAttribute("opacity", "0"); tip.classList.remove("show"); };
  const fromPointer = (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * LC.W;
    show(n > 1 ? Math.round(((sx - LC.ML) / plotW) * (n - 1)) : 0);
  };
  svg.addEventListener("pointermove", fromPointer);
  svg.addEventListener("pointerdown", fromPointer);
  svg.addEventListener("pointerleave", () => { if (document.activeElement !== box) hide(); });
  box.addEventListener("focus", () => show(cur < 0 ? n - 1 : cur));
  box.addEventListener("blur", hide);
  box.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -n, End: n }[e.key];
    if (step) { e.preventDefault(); show((cur < 0 ? n - 1 : cur) + step); }
    else if (e.key === "Escape") hide();
  });
}

function kpi(label, v, prev, sub) {
  let delta = "";
  if (prev) {
    const ch = (v - prev) / prev;
    delta = `<div class="d ${ch < 0 ? "down" : ""}">${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch * 100).toFixed(0)}% vs previous</div>`;
  }
  return `<div class="web-kpi"><div class="v">${fmtNum(v || 0)}</div><div class="l">${label}</div>${sub ? `<div class="s">${sub}</div>` : ""}${delta}</div>`;
}

function table(heads, rows, empty) {
  if (!rows.length) return `<div class="web-empty">${empty}</div>`;
  return `<div class="web-table-wrap"><table class="web-table"><thead><tr>${heads.map((h, i) =>
    `<th${i && /Visits|Views|Conv|rate/.test(h) ? ' class="num"' : ""}>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function downloadCsv() {
  const d = state.data;
  let conv = d.conversions;
  if (state.form !== "all") conv = conv.filter((c) => (state.form === "guide") === (c.form === "guide"));
  if (state.channel) conv = conv.filter((c) => (c.channel || "Direct") === state.channel);
  const cols = ["when", "type", "name", "company", "channel", "source", "medium", "campaign", "landing_page", "referrer", "converted_on", "campaign_type", "area", "device"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.join(",")].concat(conv.map((c) => [when(c.ts), FORM_LABEL[c.form] || c.form, c.name, c.company, c.channel, c.source,
    c.medium, c.campaign, c.landing, c.referrer, c.page, c.campaign_type, c.area, c.device].map(q).join(",")));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `website-conversions-${d.today}.csv`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

window.Website = { show };
