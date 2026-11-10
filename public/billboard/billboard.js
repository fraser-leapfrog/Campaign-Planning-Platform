// Billboard Reporting tab: campaigns (form, artwork picker, photo, numbers, downloads) and the
// Screens settings (Navori player + JamBox mapping + agreed plays per week).
// Talks to /api/billboard/* (worker/billboard.js). Loaded as a module by index.html; the page
// tab handler calls window.Billboard.show() when the tab is opened.

import { buildModel, fmtInt, fmtHM, niceDate, versusText, reportBasename, summaryCsv, playsCsv, footfallCsv,
  download } from "./model.js";

const API = "/api/billboard";
const LOOKBACK_DAYS = 14;   // the artwork picker also lists what played this long before the start
const PACKAGES = [["1/6", "1/6"], ["1/18", "1/18"], ["", "Don't show agreed plays"]];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const minDate = (...xs) => xs.filter(Boolean).sort()[0];

const state = {
  loaded: false, sub: "reports", status: null, screens: [], campaigns: [],
  selected: null,          // campaign id, or "new"
  form: null,              // the campaign being edited
  photo: null,             // data URL of the selected campaign's photo
  art: { key: null, list: [], loading: false, error: null }, filter: "",
  data: null,              // { id, updated_at, through, raw, model }
  sources: null, sourcesLoading: false,
};

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method || "GET", headers: opts.body ? { "content-type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* not JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// ----------------------------------------------------------------------------- entry
export function show() {
  if (!state.loaded) init();
}
window.Billboard = { show };

async function init() {
  state.loaded = true;
  const view = $("view-billboard");
  view.addEventListener("click", onClick);
  view.addEventListener("input", onInput);
  view.addEventListener("change", onChange);
  $("bb-reports").innerHTML = `<div class="bb-empty">Loading…</div>`;
  try {
    [state.status, state.screens, state.campaigns] = await Promise.all([api("/status"), api("/screens"), api("/campaigns")]);
  } catch (e) {
    $("bb-reports").innerHTML = `<div class="bb-banner">Couldn't load Billboard Reporting: ${esc(e.message)}</div>`;
    return;
  }
  select(state.campaigns[0] ? state.campaigns[0].id : "new");
}

// ----------------------------------------------------------------------------- helpers
const today = () => (state.status && state.status.today) || new Date().toISOString().slice(0, 10);
const yesterday = () => addDays(today(), -1);
const screenById = () => Object.fromEntries(state.screens.map((s) => [s.id, s]));
const savedCampaign = () => state.campaigns.find((c) => c.id === state.form.id);

function blankForm() {
  return { id: null, client_name: "", start_date: today(), end_date: addDays(today(), 27), screen_ids: [], artworks: [],
    share_of_voice: "1/6", include_footfall: true, include_extra_pages: true, notes: "", has_photo: false };
}

const FIELDS = ["client_name", "start_date", "end_date", "screen_ids", "artworks", "share_of_voice", "include_footfall",
  "include_extra_pages", "notes"];
function isDirty() {
  const saved = savedCampaign();
  if (!saved) return true;
  const norm = (c) => JSON.stringify(FIELDS.map((f) => (Array.isArray(c[f]) ? [...c[f]].sort() : c[f])));
  return norm(saved) !== norm(state.form);
}

function setMsg(id, text, error = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", !!error);
}

// ----------------------------------------------------------------------------- reports view
function select(id) {
  state.selected = id;
  const c = state.campaigns.find((x) => x.id === id);
  state.form = c ? JSON.parse(JSON.stringify(c)) : blankForm();
  state.photo = null;
  state.filter = "";
  state.data = null;
  renderReports();
  loadArtworks();
  if (c && c.has_photo) {
    api(`/campaigns/${c.id}/photo`).then((r) => { if (state.form.id === c.id) { state.photo = r.data_url; renderPhoto(); } })
      .catch(() => {});
  }
}

function banner() {
  const s = state.status;
  if (!s || (s.navori && s.datajam)) return "";
  const missing = [!s.navori && "NAVORI_USERNAME, NAVORI_PASSWORD", !s.datajam && "DATAJAM_EMAIL, DATAJAM_PASSWORD"]
    .filter(Boolean).join(", ");
  return `<div class="bb-banner"><strong>Almost there:</strong> the Navori/Datajam logins aren't on the server yet, so numbers
    can't be fetched. Add these as <em>secrets</em> in Cloudflare → Workers → campaign-planning-platform → Settings →
    Variables and Secrets: <code>${esc(missing)}</code>.</div>`;
}

function renderReports() {
  const list = state.campaigns.length ? state.campaigns.map((c) => `
    <button type="button" class="bb-item" data-act="select" data-id="${c.id}" aria-current="${c.id === state.selected}">
      <div class="bb-item-name">${esc(c.client_name)}</div>
      <div class="bb-item-meta">${esc(niceDate(c.start_date))} – ${esc(niceDate(c.end_date))}${c.share_of_voice ? ` · ${esc(c.share_of_voice)}` : ""}</div>
    </button>`).join("") : `<div class="bb-empty">No campaigns yet.</div>`;

  $("bb-reports").innerHTML = `${banner()}
    <div class="bb-layout">
      <div class="chart-card">
        <div class="chart-card-head"><h2>Campaigns</h2>
          <button type="button" class="btn btn-primary" data-act="new">New</button></div>
        <div class="bb-list">${list}</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:18px; min-width:0">
        <div class="chart-card" id="bb-editor">${editorHtml()}</div>
        <div class="chart-card" id="bb-results" ${state.form.id ? "" : "hidden"}></div>
      </div>
    </div>`;
  renderArtworks();
  renderPhoto();
  renderResults();
  updateSaveState();
}

function editorHtml() {
  const f = state.form;
  const screens = state.screens.filter((s) => s.active || f.screen_ids.includes(s.id));
  return `
    <div class="chart-card-head"><h2>${f.id ? "Campaign" : "New campaign"}</h2></div>
    <form id="bb-form" onsubmit="return false" style="display:flex; flex-direction:column; gap:16px">
      <div class="field">
        <label class="field-label" for="bb-client">Client name <span class="required-mark">*</span></label>
        <input type="text" id="bb-client" data-f="client_name" value="${esc(f.client_name)}" placeholder="e.g. Swansea University" autocomplete="off" />
        <span class="field-hint">Shown on the report as “Client | Campaign Ads Report”.</span>
      </div>
      <div class="field">
        <span class="field-label">Campaign dates</span>
        <div class="date-range">
          <input type="date" data-f="start_date" value="${esc(f.start_date)}" aria-label="Start date" />
          <span class="arrow">→</span>
          <input type="date" data-f="end_date" value="${esc(f.end_date)}" aria-label="End date (inclusive)" />
        </div>
      </div>
      <div class="field">
        <span class="field-label">Screens <span class="required-mark">*</span></span>
        <div class="chip-group">${screens.map((s) => `<button type="button" class="chip" data-act="screen-chip" data-sid="${s.id}"
          aria-pressed="${f.screen_ids.includes(s.id)}">${esc(s.name)}${s.active ? "" : " (inactive)"}</button>`).join("")}</div>
      </div>
      <div class="field">
        <span class="field-label">Package (share of voice)</span>
        <div class="chip-group">${PACKAGES.map(([v, label]) => `<button type="button" class="chip" data-act="pkg" data-pkg="${v}"
          aria-pressed="${f.share_of_voice === v}">${esc(label)}</button>`).join("")}</div>
        <span class="field-hint">Agreed plays come from each screen's weekly rate (Screens tab), pro-rated to the days in the report.</span>
      </div>
      <div class="field">
        <span class="field-label">Report options</span>
        <label class="bb-check"><input type="checkbox" data-f="include_footfall" ${f.include_footfall ? "checked" : ""}/> Include footfall data (potential impressions)</label>
        <label class="bb-check"><input type="checkbox" data-f="include_extra_pages" ${f.include_extra_pages ? "checked" : ""}/> Include extra pages (daily performance, time of day)</label>
      </div>
      <div class="field">
        <span class="field-label" id="bb-art-label">Artworks</span>
        <div class="bb-art-tools">
          <input type="text" id="bb-art-filter" placeholder="Filter, e.g. skechers" value="${esc(state.filter)}" autocomplete="off" />
          <button type="button" class="btn btn-ghost" data-act="art-all">Select all shown</button>
          <button type="button" class="btn btn-ghost" data-act="art-none">Clear</button>
        </div>
        <div class="bb-art-list" id="bb-art-list"></div>
        <span class="field-hint" id="bb-art-hint"></span>
      </div>
      <div class="field">
        <span class="field-label">Photo (optional)</span>
        <div id="bb-photo"></div>
      </div>
      <div class="field">
        <label class="field-label" for="bb-notes">Notes (internal, not on the report)</label>
        <textarea id="bb-notes" data-f="notes" rows="2">${esc(f.notes)}</textarea>
      </div>
      <div class="bb-actions">
        <button type="button" class="btn btn-primary" data-act="save" id="bb-save">${f.id ? "Save changes" : "Save campaign"}</button>
        ${f.id ? `<button type="button" class="btn btn-ghost btn-danger" data-act="delete">Delete</button>` : ""}
        <span class="bb-msg" id="bb-save-msg"></span>
      </div>
    </form>`;
}

function updateSaveState() {
  const b = $("bb-save");
  if (b) b.disabled = !!state.form.id && !isDirty();
  const fetchBtn = $("bb-fetch");
  if (fetchBtn) fetchBtn.disabled = isDirty();
  const dirtyNote = $("bb-dirty-note");
  if (dirtyNote) dirtyNote.hidden = !isDirty();
}

// ---- artworks
function artworkKey() {
  const f = state.form;
  const byId = screenById();
  const players = [...new Set(f.screen_ids.map((i) => byId[i] && byId[i].navori_player_id).filter(Boolean))].sort();
  const start = addDays(f.start_date, -LOOKBACK_DAYS);
  const end = minDate(f.end_date, today());
  return { players, start, end, key: `${players.join(",")}|${start}|${end}` };
}

let artTimer = null;
function loadArtworks() {
  clearTimeout(artTimer);
  artTimer = setTimeout(async () => {
    const { players, start, end, key } = artworkKey();
    if (key === state.art.key) return;
    state.art = { key, list: [], loading: !!players.length, error: null };
    renderArtworks();
    if (!players.length || !start || !end || end < start) return;
    try {
      const list = await api(`/artworks?players=${players.join(",")}&start=${start}&end=${end}`);
      if (state.art.key === key) state.art = { key, list, loading: false, error: null };
    } catch (e) {
      if (state.art.key === key) state.art = { key, list: [], loading: false, error: e.message };
    }
    renderArtworks();
  }, 350);
}

function visibleArtworks() {
  const counts = Object.fromEntries(state.art.list.map((a) => [a.artwork, a.plays]));
  const missing = state.form.artworks.filter((a) => !(a in counts)).map((a) => ({ artwork: a, plays: null }));
  const q = state.filter.trim().toLowerCase();
  return [...missing, ...state.art.list].filter((a) => !q || a.artwork.toLowerCase().includes(q));
}

function renderArtworks() {
  const el = $("bb-art-list");
  if (!el) return;
  const f = state.form;
  const { start, end, players } = artworkKey();
  const rows = visibleArtworks();
  el.innerHTML = rows.length ? rows.map((a) => `
    <label class="bb-art-row${a.plays === null ? " missing" : ""}">
      <input type="checkbox" data-art="${esc(a.artwork)}" ${f.artworks.includes(a.artwork) ? "checked" : ""}/>
      <span class="name">${esc(a.artwork)}</span>
      <span class="plays">${a.plays === null ? "no plays found" : `${fmtInt(a.plays)} plays`}</span>
    </label>`).join("")
    : `<div class="bb-empty">${state.art.loading ? "Loading artwork names from Navori…"
      : state.art.error ? esc(state.art.error) : !players.length ? "Pick screens first to see which artworks played on them."
      : state.filter ? "Nothing matches that filter." : "No plays found on these screens in this period."}</div>`;
  $("bb-art-label").innerHTML = `Artworks <span class="required-mark">*</span> <span class="field-hint">(${f.artworks.length} selected)</span>`;
  $("bb-art-hint").textContent = players.length
    ? `Artworks that played on the selected screens between ${niceDate(start)} and ${niceDate(end)}, most played first. Navori identifies artwork by file name, so tick every version used in this campaign.`
    : "";
}

// ---- photo
function renderPhoto() {
  const el = $("bb-photo");
  if (!el) return;
  const f = state.form;
  if (!f.id) { el.innerHTML = `<span class="field-hint">Save the campaign first, then add a photo for the report's front page.</span>`; return; }
  el.innerHTML = `<div class="bb-photo">
      ${state.photo ? `<img src="${state.photo}" alt="Campaign photo" />` : ""}
      <div style="display:flex; flex-direction:column; gap:8px">
        <label class="btn btn-ghost" style="cursor:pointer; align-self:flex-start">${state.photo || f.has_photo ? "Replace photo" : "Add a photo"}
          <input type="file" accept="image/jpeg,image/png" id="bb-photo-file" hidden /></label>
        ${state.photo || f.has_photo ? `<button type="button" class="btn btn-ghost btn-danger" data-act="photo-remove" style="align-self:flex-start">Remove photo</button>` : ""}
        <span class="field-hint">A photo of the screen showing the advert, for the front page. Without one, the front page uses a layout with no photo.</span>
        <span class="bb-msg" id="bb-photo-msg"></span>
      </div></div>`;
}

function resizeImage(file, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = Object.assign(document.createElement("canvas"),
        { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("That file isn't an image the browser can read."));
    img.src = URL.createObjectURL(file);
  });
}

async function uploadPhoto(file) {
  const f = state.form;
  setMsg("bb-photo-msg", "Uploading…");
  try {
    const dataUrl = await resizeImage(file);
    await api(`/campaigns/${f.id}/photo`, { method: "PUT", body: { data_url: dataUrl } });
    state.photo = dataUrl;
    f.has_photo = true;
    const c = savedCampaign(); if (c) c.has_photo = true;
    renderPhoto();
  } catch (e) { setMsg("bb-photo-msg", e.message, true); }
}

// ---- results
function renderResults() {
  const el = $("bb-results");
  if (!el || !state.form.id) return;
  const c = savedCampaign();
  const last = minDate(c.end_date, yesterday());
  if (last < c.start_date) {
    el.innerHTML = `<div class="chart-card-head"><h2>Campaign numbers</h2></div>
      <p class="field-hint">No complete days of data yet. The campaign starts ${esc(niceDate(c.start_date))}.</p>`;
    return;
  }
  const d = state.data && state.data.id === c.id && state.data.updated_at === c.updated_at ? state.data : null;
  el.innerHTML = `
    <div class="chart-card-head"><h2>Campaign numbers</h2></div>
    <div class="bb-actions" style="margin-top:0">
      <div class="field" style="gap:4px"><label class="field-label" for="bb-through">Include data up to</label>
        <input type="date" id="bb-through" value="${esc(d ? d.through : last)}" min="${esc(c.start_date)}" max="${esc(last)}" /></div>
      <button type="button" class="btn btn-primary" data-act="fetch" id="bb-fetch" style="align-self:flex-end">Fetch numbers</button>
      <span class="bb-msg" id="bb-fetch-msg" style="align-self:flex-end"></span>
    </div>
    <p class="field-hint" id="bb-dirty-note" hidden>You have unsaved changes. Save the campaign before fetching its numbers.</p>
    <p class="field-hint">Pick an earlier date for an interim report. Today is never included because its data is incomplete.</p>
    <div id="bb-numbers">${d ? numbersHtml(d) : ""}</div>`;
}

function numbersHtml(d) {
  const m = d.model;
  const t = m.totals();
  const avd = m.agreedVsDelivered();
  const kind = m.isComplete ? "Final" : "Interim";
  const stats = [];
  if (avd) stats.push(`<div class="bb-stat"><div class="v">${fmtInt(avd.agreed)}</div><div class="l">Agreed plays</div>
      <div class="field-hint">${esc(avd.package)} · ${fmtInt(avd.weekly)} per week</div></div>`);
  stats.push(`<div class="bb-stat delivered"><div class="v">${fmtInt(t.plays)}</div><div class="l">${avd ? "Delivered plays" : "Total plays"}</div>
      ${avd ? `<div class="d${avd.ratio < 1 ? " under" : ""}">${esc(versusText(avd.ratio))}</div>` : ""}</div>`);
  stats.push(`<div class="bb-stat"><div class="v">${fmtHM(t.airtime_s)}</div><div class="l">Total time played</div></div>`);
  if (m.includeFootfall) stats.push(`<div class="bb-stat"><div class="v">${fmtInt(t.impressions)}</div><div class="l">Potential impressions</div></div>`);

  const avdTable = avd ? `<h3 class="bb-h3">Agreed vs delivered</h3><div class="bb-table-wrap"><table class="bb-table">
      <thead><tr><th>Location</th><th>Screens</th><th class="num">Agreed / week</th><th class="num">Agreed (period)</th>
        <th class="num">Delivered</th><th class="num">vs agreed</th></tr></thead><tbody>
      ${avd.locations.map((r) => `<tr><td>${esc(r.location)}</td><td>${esc(r.screens.join(", "))}</td><td class="num">${fmtInt(r.weekly)}</td>
        <td class="num">${fmtInt(r.agreed)}</td><td class="num">${fmtInt(r.delivered)}</td>
        <td class="num">${r.ratio === null ? "–" : `${r.ratio >= 1 ? "+" : ""}${Math.round((r.ratio - 1) * 100)}%`}</td></tr>`).join("")}
      </tbody></table></div>` : "";
  const content = m.byArtworkScreen();
  const contentTable = `<h3 class="bb-h3">By content</h3><div class="bb-table-wrap"><table class="bb-table">
      <thead><tr><th>Content</th><th>Location</th><th class="num">Plays</th><th class="num">Time played</th></tr></thead><tbody>
      ${content.map((r) => `<tr><td>${esc(r.artwork)}</td><td>${esc(r.screen)}</td><td class="num">${fmtInt(r.plays)}</td>
        <td class="num">${fmtHM(r.airtime_s)}</td></tr>`).join("") || `<tr><td colspan="4">No plays found.</td></tr>`}
      </tbody></table></div>`;
  const locTable = m.includeFootfall ? `<h3 class="bb-h3">Potential impressions by location</h3><div class="bb-table-wrap"><table class="bb-table">
      <thead><tr><th>Location</th><th>Screens</th><th>JamBox</th><th class="num">Impressions</th></tr></thead><tbody>
      ${m.impressionsByLocation().map((r) => `<tr><td>${esc(r.location)}</td><td>${esc(r.screens.join(", "))}</td><td>${esc(r.device)}</td>
        <td class="num">${fmtInt(r.impressions)}</td></tr>`).join("")}</tbody></table></div>` : "";

  return `
    <p style="margin:14px 0 0"><strong>${kind} numbers</strong> · ${esc(niceDate(m.start))} – ${esc(niceDate(m.end))} ·
      ${t.days} days · ${t.screens} screens</p>
    <div class="bb-stats">${stats.join("")}</div>
    ${m.warnings.map((w) => `<div class="bb-warn">${esc(w)}</div>`).join("")}
    ${m.warnings.length ? `<p class="field-hint">Check the warnings before sending. They aren't printed on the client report.</p>` : ""}
    <div class="bb-actions">
      <button type="button" class="btn btn-primary" data-act="report">Open report / Save as PDF</button>
      <button type="button" class="btn btn-ghost" data-act="csv-summary">CSV (screen × day)</button>
      <button type="button" class="btn btn-ghost" data-act="csv-plays">Plays by artwork CSV</button>
      ${m.includeFootfall ? `<button type="button" class="btn btn-ghost" data-act="csv-footfall">Hourly footfall CSV</button>` : ""}
    </div>
    ${avdTable}${contentTable}${locTable}`;
}

async function fetchNumbers() {
  const c = savedCampaign();
  const through = $("bb-through").value;
  setMsg("bb-fetch-msg", `Fetching plays from Navori${c.include_footfall ? " and footfall from Datajam" : ""}… this can take up to a minute for long campaigns.`);
  $("bb-fetch").disabled = true;
  try {
    const raw = await api(`/campaigns/${c.id}/data?through=${encodeURIComponent(through)}`);
    state.data = { id: c.id, updated_at: c.updated_at, through: raw.end, raw, model: buildModel(raw) };
    renderResults();
  } catch (e) {
    setMsg("bb-fetch-msg", e.message, true);
    $("bb-fetch").disabled = false;
  }
}

// ---- save / delete
async function saveCampaign() {
  const f = state.form;
  const body = Object.fromEntries(FIELDS.map((k) => [k, f[k]]));
  setMsg("bb-save-msg", "Saving…");
  try {
    const saved = f.id ? await api(`/campaigns/${f.id}`, { method: "PATCH", body }) : await api("/campaigns", { method: "POST", body });
    saved.has_photo = f.has_photo;
    state.campaigns = await api("/campaigns");
    select(saved.id);
    setMsg("bb-save-msg", "Saved.");
  } catch (e) { setMsg("bb-save-msg", e.message, true); }
}

async function deleteCampaign() {
  const f = state.form;
  if (!confirm(`Delete the ${f.client_name} campaign and its photo? This can't be undone. Nothing in Navori or Datajam is affected.`)) return;
  try {
    await api(`/campaigns/${f.id}`, { method: "DELETE" });
    state.campaigns = state.campaigns.filter((c) => c.id !== f.id);
    select(state.campaigns[0] ? state.campaigns[0].id : "new");
  } catch (e) { setMsg("bb-save-msg", e.message, true); }
}

// ----------------------------------------------------------------------------- screens view
async function loadSources(force = false) {
  if ((state.sources && !force) || state.sourcesLoading) return;
  state.sourcesLoading = true;
  renderScreens();
  try { state.sources = await api("/sources"); } catch (e) { state.sources = { players: [], devices: [], errors: [e.message] }; }
  state.sourcesLoading = false;
  renderScreens();
}

function screenRow(s) {
  const players = [...((state.sources && state.sources.players) || [])];
  if (s.navori_player_id && !players.some((p) => p.id === s.navori_player_id)) players.push({ id: s.navori_player_id, name: "?" });
  const devices = [...((state.sources && state.sources.devices) || [])];
  if (s.datajam_device && !devices.some((d) => d.device === s.datajam_device && d.project === s.datajam_project)) {
    devices.push({ project: s.datajam_project, device: s.datajam_device, location: "?" });
  }
  const devVal = s.datajam_device ? `${s.datajam_project}|${s.datajam_device}` : "";
  const id = s.id || "new";
  return `<tr data-row="${id}">
    <td><input type="text" data-k="name" value="${esc(s.name)}" placeholder="e.g. Quadrant" /></td>
    <td><input type="text" data-k="location" value="${esc(s.location)}" placeholder="e.g. Quadrant Shopping Centre, Swansea" /></td>
    <td><select data-k="player"><option value="">—</option>${players.map((p) => `<option value="${p.id}" ${p.id === s.navori_player_id ? "selected" : ""}>${esc(p.name)} (${p.id})</option>`).join("")}</select></td>
    <td><select data-k="device"><option value="">— none —</option>${devices.map((d) => {
      const v = `${d.project}|${d.device}`;
      return `<option value="${esc(v)}" ${v === devVal ? "selected" : ""}>${esc(d.device)} · ${esc(d.location || "no location")}</option>`;
    }).join("")}</select></td>
    <td><input type="number" min="0" step="1" data-k="a16" value="${s.agreed_week_1_6 ?? ""}" /></td>
    <td><input type="number" min="0" step="1" data-k="a118" value="${s.agreed_week_1_18 ?? ""}" /></td>
    <td style="text-align:center"><input type="checkbox" data-k="active" ${s.active !== false ? "checked" : ""} /></td>
    <td class="act"><button type="button" class="btn btn-ghost" data-act="screen-save" data-id="${id}">Save</button>
      ${s.id ? `<button type="button" class="btn btn-ghost btn-danger" data-act="screen-delete" data-id="${id}">Delete</button>` : ""}</td>
  </tr>`;
}

function renderScreens() {
  const el = $("bb-screens");
  const src = state.sources;
  const health = src && src.devices.length ? `
    <div class="chart-card"><div class="chart-card-head"><h2>JamBox health</h2></div>
      <p class="field-hint" style="margin:-4px 0 10px">From Datajam. <strong>Disabled</strong> means Datajam has stopped counting
        that unit. Email devteam@data-jam.com to re-enable it.</p>
      <div class="bb-table-wrap"><table class="bb-table bb-health"><thead><tr><th>JamBox</th><th>Project</th><th>Location</th>
        <th>Registration</th><th>Last seen (UTC)</th></tr></thead><tbody>
      ${src.devices.map((d) => `<tr><td>${esc(d.device)}</td><td>${esc(d.project)}</td><td>${esc(d.location || "")}</td>
        <td class="${d.status === "Disabled" ? "disabled" : ""}">${esc(d.status || "")}</td><td>${esc(d.last_seen || "never")}</td></tr>`).join("")}
      </tbody></table></div></div>` : "";
  el.innerHTML = `${banner()}
    <div class="chart-card">
      <div class="chart-card-head"><h2>Screens</h2>
        <button type="button" class="btn btn-ghost" data-act="sources-refresh">${state.sourcesLoading ? "Loading lists…" : "Refresh lists from Navori/Datajam"}</button></div>
      <p class="field-hint" style="margin:-4px 0 10px">Each screen links a Navori player (plays) to a Datajam JamBox (footfall).
        <strong>Location</strong> is shown next to potential impressions on the report; the screen <strong>Name</strong> appears in the
        report's Location column. <strong>Agreed / week</strong> is the plays agreed per week for <em>this screen</em> at each package;
        a location's total is the sum of its screens (e.g. Parc Tawe 15,960 at 1/6 = 7,980 per screen).</p>
      ${src && src.errors.length ? src.errors.map((e) => `<div class="bb-warn">${esc(e)}</div>`).join("") : ""}
      <div class="bb-table-wrap"><table class="bb-table bb-screens"><thead><tr>
        <th>Name</th><th>Location</th><th>Navori player</th><th>JamBox</th><th>Agreed / week (1/6)</th><th>Agreed / week (1/18)</th>
        <th>Active</th><th></th></tr></thead><tbody>
        ${state.screens.map(screenRow).join("")}
        ${screenRow({ id: null, name: "", location: "", active: true })}
      </tbody></table></div>
      <p class="field-hint">Use the last row to add a new screen. <span class="bb-msg" id="bb-screens-msg"></span></p>
    </div>
    <div style="height:18px"></div>${health}`;
}

async function saveScreen(id) {
  const row = document.querySelector(`#bb-screens tr[data-row="${id}"]`);
  const v = (k) => row.querySelector(`[data-k="${k}"]`);
  const [project, device] = (v("device").value || "|").split("|");
  const body = {
    name: v("name").value.trim(), location: v("location").value.trim(),
    navori_player_id: v("player").value ? Number(v("player").value) : null,
    datajam_project: project || null, datajam_device: device || null,
    agreed_week_1_6: v("a16").value === "" ? null : Number(v("a16").value),
    agreed_week_1_18: v("a118").value === "" ? null : Number(v("a118").value),
    active: v("active").checked, notes: "",
  };
  const existing = state.screens.find((s) => String(s.id) === String(id));
  if (existing) body.notes = existing.notes || "";
  setMsg("bb-screens-msg", "Saving…");
  try {
    if (id === "new") await api("/screens", { method: "POST", body });
    else await api(`/screens/${id}`, { method: "PATCH", body });
    state.screens = await api("/screens");
    renderScreens();
    setMsg("bb-screens-msg", `Saved ${body.name}.`);
  } catch (e) { setMsg("bb-screens-msg", e.message, true); }
}

async function deleteScreen(id) {
  const s = state.screens.find((x) => String(x.id) === String(id));
  if (!s || !confirm(`Delete the screen “${s.name}”?`)) return;
  try {
    await api(`/screens/${id}`, { method: "DELETE" });
    state.screens = await api("/screens");
    renderScreens();
  } catch (e) { setMsg("bb-screens-msg", e.message, true); }
}

// ----------------------------------------------------------------------------- events
function onClick(e) {
  const tab = e.target.closest("#bb-subtabs .tab-btn");
  if (tab) {
    state.sub = tab.dataset.bb;
    [...$("bb-subtabs").children].forEach((b) => b.setAttribute("aria-selected", String(b === tab)));
    $("bb-reports").hidden = state.sub !== "reports";
    $("bb-screens").hidden = state.sub !== "screens";
    if (state.sub === "screens") { renderScreens(); loadSources(); }
    else if (state.loaded && state.form) renderReports();
    return;
  }
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const f = state.form;
  switch (el.dataset.act) {
    case "new": select("new"); break;
    case "select": select(Number(el.dataset.id)); break;
    case "screen-chip": {
      const sid = Number(el.dataset.sid);
      f.screen_ids = f.screen_ids.includes(sid) ? f.screen_ids.filter((x) => x !== sid) : [...f.screen_ids, sid].sort((a, b) => a - b);
      el.setAttribute("aria-pressed", String(f.screen_ids.includes(sid)));
      loadArtworks(); renderArtworks(); updateSaveState();
      break;
    }
    case "pkg":
      f.share_of_voice = el.dataset.pkg;
      el.parentElement.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === el)));
      updateSaveState();
      break;
    case "art-all":
      f.artworks = [...new Set([...f.artworks, ...visibleArtworks().filter((a) => a.plays !== null).map((a) => a.artwork)])];
      renderArtworks(); updateSaveState();
      break;
    case "art-none": f.artworks = []; renderArtworks(); updateSaveState(); break;
    case "save": saveCampaign(); break;
    case "delete": deleteCampaign(); break;
    case "photo-remove":
      api(`/campaigns/${f.id}/photo`, { method: "DELETE" }).then(() => {
        state.photo = null; f.has_photo = false;
        const c = savedCampaign(); if (c) c.has_photo = false;
        renderPhoto();
      }).catch((err) => setMsg("bb-photo-msg", err.message, true));
      break;
    case "fetch": fetchNumbers(); break;
    case "report":
      window.open(`/billboard/report.html?id=${state.data.id}&through=${encodeURIComponent(state.data.through)}`, "_blank");
      break;
    case "csv-summary": download(`${reportBasename(state.data.model)}.csv`, summaryCsv(state.data.model)); break;
    case "csv-plays": download(`${reportBasename(state.data.model)}_plays.csv`, playsCsv(state.data.raw)); break;
    case "csv-footfall": download(`${reportBasename(state.data.model)}_footfall_hourly.csv`, footfallCsv(state.data.raw)); break;
    case "sources-refresh": loadSources(true); break;
    case "screen-save": saveScreen(el.dataset.id); break;
    case "screen-delete": deleteScreen(el.dataset.id); break;
    default: break;
  }
}

function onInput(e) {
  const t = e.target;
  if (t.id === "bb-art-filter") { state.filter = t.value; renderArtworks(); return; }
  const k = t.dataset && t.dataset.f;
  if (!k || !state.form || t.type === "checkbox") return;
  state.form[k] = t.value;
  if (k === "start_date" || k === "end_date") loadArtworks();
  updateSaveState();
}

function onChange(e) {
  const t = e.target;
  if (t.dataset && t.dataset.art !== undefined) {
    const a = t.dataset.art;
    const f = state.form;
    f.artworks = t.checked ? [...new Set([...f.artworks, a])] : f.artworks.filter((x) => x !== a);
    $("bb-art-label").innerHTML = `Artworks <span class="required-mark">*</span> <span class="field-hint">(${f.artworks.length} selected)</span>`;
    updateSaveState();
    return;
  }
  if (t.id === "bb-photo-file" && t.files && t.files[0]) { uploadPhoto(t.files[0]); return; }
  const k = t.dataset && t.dataset.f;
  if (k && t.type === "checkbox") { state.form[k] = t.checked; updateSaveState(); }
}
