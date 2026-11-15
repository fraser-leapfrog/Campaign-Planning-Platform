// Website tab → Analytics: visits, page views, acquisition channels and sources for
// leapfrogadvertising.com, and where every enquiry / guide download came from.
// Data: GET /api/website/summary?days=N (worker/website.js). Loaded as a module by index.html;
// the page tab handler calls window.Website.show() when the tab is opened.

import { columnChart, fmtNum } from "../billboard/charts.js";

const RANGES = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["365", "12 months"]];
const METRICS = [["views", "Page views"], ["sessions", "Visits"], ["visitors", "Visitors"], ["conversions", "Conversions"]];
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
const when = (ms) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

const state = { days: "30", metric: "views", data: null, loading: false, error: null, form: "all", channel: null };

// ----------------------------------------------------------------------------- entry
let shown = false;
export async function show() {
  if (!shown) { shown = true; $("web-analytics").addEventListener("click", onClick); }
  await load();
}

async function load() {
  state.loading = true; state.error = null; render();
  try {
    const res = await fetch(`/api/website/summary?days=${state.days}`, { cache: "no-store" });
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
  if (act === "range") { state.days = t.dataset.v; load(); }
  else if (act === "metric") { state.metric = t.dataset.v; render(); }
  else if (act === "refresh") load();
  else if (act === "form") { state.form = t.dataset.v; render(); }
  else if (act === "channel") { state.channel = state.channel === t.dataset.v ? null : t.dataset.v; render(); if (state.channel) $("web-conv").scrollIntoView({ behavior: "smooth", block: "start" }); }
  else if (act === "clear-channel") { state.channel = null; render(); }
  else if (act === "csv") downloadCsv();
}

// ----------------------------------------------------------------------------- render
function render() {
  const root = $("web-analytics");
  const d = state.data;
  const chips = (act, list, cur) => list.map(([v, l]) =>
    `<button type="button" class="chip range-chip" data-act="${act}" data-v="${v}" aria-pressed="${v === cur}">${l}</button>`).join("");
  let html = `<div class="range-row">
      <span class="range-label">Window</span>
      <div class="chip-group" role="group" aria-label="Date range">${chips("range", RANGES, state.days)}</div>
      <button type="button" class="btn btn-ghost web-refresh" data-act="refresh"${state.loading ? " disabled" : ""}>${state.loading ? "Loading…" : "Refresh"}</button>
    </div>`;
  if (state.error) html += `<div class="web-banner">Couldn't load website analytics: ${esc(state.error)}</div>`;
  if (!d) { root.innerHTML = html + (state.loading ? `<div class="web-empty">Loading…</div>` : ""); return; }

  const T = d.totals, P = d.previous;
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

  // Over time
  const series = d.daily.map((x) => x[state.metric]);
  const every = Math.max(1, Math.ceil(d.daily.length / 10));
  html += `<div class="chart-card web-card">
    <div class="chart-card-head"><h2>Over time</h2><div class="chip-group">${chips("metric", METRICS, state.metric)}</div></div>
    ${columnChart(d.daily.map((x) => dayLabel(x.day)), series, { width: 900, height: 240, labelEvery: every, axisFont: 11,
      title: METRICS.find((m) => m[0] === state.metric)[1] + " per day" })}
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
  <p class="web-note">How this is counted: every visit to leapfrogadvertising.com is recorded without cookies or anything stored on the
    visitor's device, so it includes people who decline the cookie banner (Google Analytics only sees those who accept).
    A visit ends after 30 minutes of inactivity. Visitors are counted per day. Each conversion is credited to the source of the
    visit it happened in: Google Ads clicks, UTM-tagged links (e.g. QR codes on billboards), search engines, social sites, other websites, or Direct.</p>`;
  root.innerHTML = html;
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
