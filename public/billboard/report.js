// Builds the client report (16:9 slides copied from Leapfrog's Google Slides report) in the browser.
// Open as /billboard/report.html?id=<campaign id>&through=<YYYY-MM-DD>. "Save as PDF" uses the
// browser's print-to-PDF (Chrome/Edge), so the output is the same Chromium rendering as the local tool.

import { buildModel, fmtInt, fmtHM, fmtHMS, periodParts, versusText, reportBasename, niceDate, longDate } from "./model.js";
import { columnChart } from "./charts.js";

const ROWS_FIRST_SLIDE = 8;    // table rows under the tiles on the detail slide
const ROWS_PER_SLIDE = 12;     // table rows on a continuation slide

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);

function header(title, big = false) {
  return `<div class="brand-tag">LEAPFROG ADVERTISING</div><div class="report-tag">CAMPAIGN REPORT</div>
    <h1 class="title${big ? " big" : ""}">${esc(title)}</h1><div class="rule"></div>`;
}

function perfTable(rows) {
  return `<table class="perf"><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"></colgroup>
    <thead><tr><th>Content</th><th>Location</th><th>Total Plays</th><th>Total Time Played</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td${r.artwork.length > 42 ? ' class="long"' : ""}>${esc(r.artwork)}</td><td>${esc(r.screen)}</td>
      <td>${fmtInt(r.plays)}</td><td>${fmtHMS(r.airtime_s)}</td></tr>`).join("")}</tbody></table>`;
}

function buildSlides(model, photo) {
  const c = model.campaign;
  const t = model.totals();
  const footfall = model.includeFootfall && t.impressions !== null;
  const avd = model.agreedVsDelivered();
  const agreed = avd && { agreed: fmtInt(avd.agreed), weekly: fmtInt(avd.weekly), pkg: avd.package, versus: versusText(avd.ratio) };
  const out = [];

  // ---- slide 1: headline (impressions per location, or delivered plays per screen when footfall is off)
  let headline;
  if (footfall) {
    headline = { value: fmtInt(t.impressions), label: "Potential Impressions", source: "Datajam",
      rows: model.impressionsByLocation().map((r) => ({ value: fmtInt(r.impressions), name: r.location })) };
  } else {
    headline = { value: fmtInt(t.plays), label: agreed ? "Delivered Plays" : "Total Plays", source: "Navori proof-of-play",
      rows: model.byScreen().map((r) => ({ value: fmtInt(r.plays), name: r.screen })),
      sub: agreed ? `Agreed: ${agreed.agreed} (${agreed.pkg}) · ${agreed.versus}` : "" };
  }
  headline.rows = headline.rows.slice(0, 4);
  out.push(`<div class="slide cover${photo ? "" : " nophoto"}">
    ${header(`${c.client_name} | Campaign Ads Report`, true)}
    ${photo ? `<div class="photo" style="background-image:url('${photo}')"></div>` : ""}
    <div class="headline"><div class="num">${headline.value}</div><div class="label">${esc(headline.label)}</div>
      ${headline.sub ? `<div class="sub">${esc(headline.sub)}</div>` : ""}</div>
    <div class="locations${headline.rows.length > 3 ? " compact" : ""}">
      ${headline.rows.map((r) => `<div class="loc"><div class="n">${r.value}</div><div class="name">${esc(r.name)}</div></div>`).join("")}
    </div>
    <div class="source">Source: ${esc(headline.source)}</div>
    <div class="logo"><img src="/billboard/logo.png" alt="Leapfrog Advertising"></div>
  </div>`);

  // ---- slide 2+: performance detail
  const period = periodParts(model.start, model.end);
  const note = model.isComplete ? "" : `Interim report. The campaign runs until ${longDate(c.end_date)}.`;
  let rows = model.byArtworkScreen();
  if (!rows.length) rows = [{ artwork: "No plays found", screen: "", plays: 0, airtime_s: 0 }];
  const pages = [rows.slice(0, ROWS_FIRST_SLIDE)];
  for (let i = ROWS_FIRST_SLIDE; i < rows.length; i += ROWS_PER_SLIDE) pages.push(rows.slice(i, i + ROWS_PER_SLIDE));
  out.push(`<div class="slide detail">${header("Campaign Performance Detail")}
    <div class="boxes n${agreed ? 4 : 3}">
      ${agreed ? `<div class="tile"><div class="num">${agreed.agreed}</div><div class="label">Agreed Plays</div>
          <div class="sub">${esc(agreed.pkg)} package · ${agreed.weekly} per week</div></div>
        <div class="tile delivered"><div class="num">${fmtInt(t.plays)}</div><div class="label">Delivered Plays</div>
          <div class="sub strong">${esc(agreed.versus)}</div></div>`
      : `<div class="tile"><div class="num">${fmtInt(t.plays)}</div><div class="label">Total Plays</div></div>`}
      <div class="tile"><div class="num">${fmtHM(t.airtime_s)}</div><div class="label">Total Time Played</div></div>
      <div class="period"><div class="label">Reporting Period</div><div class="dates">${esc(period.dates)}</div>
        <div class="year">${esc(period.year)}</div>${note ? `<div class="note">${esc(note)}</div>` : ""}</div>
    </div>
    ${perfTable(pages[0])}</div>`);
  for (const p of pages.slice(1)) {
    out.push(`<div class="slide continued">${header("Campaign Performance Detail (continued)")}${perfTable(p)}</div>`);
  }

  // ---- optional extra slides
  if (c.include_extra_pages) {
    const days = model.byDay();
    const labelEvery = Math.max(1, Math.ceil(days.length / (footfall ? 8 : 14)));
    const labels = days.map((d) => niceDate(d.date, { year: false }));
    const w = footfall ? 536 : 1130;
    const agreedDay = avd ? avd.weekly / 7 : null;
    const key = agreedDay ? `<span class="ref-key"><i></i>Agreed: ${fmtInt(agreedDay)} per day</span>` : "";
    const playsChart = columnChart(labels, days.map((d) => d.plays), { width: w, height: 440, labelEvery, axisFont: 14,
      refValue: agreedDay, title: "Plays per day" });
    out.push(`<div class="slide">${header("Daily Performance")}
      ${footfall
        ? `<div class="panel left"><div class="cap">Plays per day${key}</div>${playsChart}</div>
           <div class="panel right"><div class="cap">Potential impressions per day</div>
           ${columnChart(labels, days.map((d) => d.impressions || 0), { width: w, height: 440, labelEvery, axisFont: 14, title: "Potential impressions per day" })}</div>`
        : `<div class="panel full"><div class="cap">Plays per day${key}</div>${playsChart}</div>`}
      <div class="foot-source">Source: Navori${footfall ? " (plays), Datajam (impressions)" : ""}</div></div>`);

    if (footfall) {
      const hourly = model.hourlyProfile();
      const peakH = hourly.reduce((a, b) => (b.avg > a.avg ? b : a));
      const peakD = days.reduce((a, b) => ((b.impressions || 0) > (a.impressions || 0) ? b : a));
      out.push(`<div class="slide">${header("Footfall by Time of Day")}
        <div class="panel wide"><div class="cap">Average potential impressions per hour</div>
          ${columnChart(hourly.map((h) => String(h.hour).padStart(2, "0")), hourly.map((h) => h.avg),
            { width: 790, height: 440, labelEvery: 2, axisFont: 14, title: "Average impressions per hour" })}</div>
        <div class="side" style="top:120pt">
          <div class="tile"><div class="num">${String(peakH.hour).padStart(2, "0")}:00</div><div class="label">Busiest hour</div>
            <div class="sub">${fmtInt(peakH.avg)} impressions on an average day</div></div>
          <div class="tile"><div class="num">${esc(niceDate(peakD.date, { year: false, dow: true }))}</div><div class="label">Busiest day</div>
            <div class="sub">${fmtInt(peakD.impressions)} impressions</div></div>
          <div class="tile"><div class="num">${fmtInt(t.impressions / Math.max(days.length, 1))}</div><div class="label">Daily average</div>
            <div class="sub">potential impressions per day</div></div>
        </div>
        <div class="foot-source">Source: Datajam</div></div>`);
    }
  }
  return out.join("\n");
}

async function main() {
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  const through = params.get("through") || "";
  if (!id) throw new Error("No campaign given.");
  const [dataRes, photoRes] = await Promise.all([
    fetch(`/api/billboard/campaigns/${encodeURIComponent(id)}/data?through=${encodeURIComponent(through)}`),
    fetch(`/api/billboard/campaigns/${encodeURIComponent(id)}/photo`),
  ]);
  const raw = await dataRes.json();
  if (!dataRes.ok) throw new Error(raw.error || `HTTP ${dataRes.status}`);
  const photo = photoRes.ok ? (await photoRes.json()).data_url : null;
  const model = buildModel(raw);

  $("slides").innerHTML = buildSlides(model, photo);
  // On screen, shrink the 1280px-wide slides to fit narrow windows (printing ignores this).
  const fit = () => { $("slides").style.zoom = String(Math.min(1, (window.innerWidth - 32) / 1280)); };
  fit();
  window.addEventListener("resize", fit);
  const name = reportBasename(model);
  document.title = name;                     // Chrome uses this as the PDF file name
  $("tb-title").textContent = `${model.campaign.client_name} · ${model.isComplete ? "Final" : "Interim"} report`;
  $("status").remove();
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  $("save-pdf").disabled = false;
  $("save-pdf").addEventListener("click", () => window.print());
}

main().catch((e) => {
  const s = $("status");
  s.classList.add("error");
  s.textContent = `Couldn't build the report: ${e.message}`;
});
