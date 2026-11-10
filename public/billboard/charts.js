// Small hand-written SVG column charts for the report (port of charts.py).
// One axis per chart; bars <= 24px, rounded only at the data end; hairline grid;
// labels in ink colours; an optional reference line (agreed plays per day).

const SERIES = "#510780";   // deep purple bars
const MUTED = "#8b7797";    // mauve axis labels
const GRID = "#eee0f5";     // lavender hairlines
const BASELINE = "#c9b3d8";
const REF = "#e43f84";      // Leapfrog pink: agreed-plays line

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function niceTicks(max, target = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const n = Math.ceil(max / step);
  return Array.from({ length: n + 1 }, (_, i) => i * step);
}

export function fmtNum(v) {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(v) >= 1e4) return `${Math.round(v / 1000)}k`;
  if (v !== Math.round(v)) return v.toFixed(1);
  return Math.round(v).toLocaleString("en-GB");
}

function column(x, yTop, w, yBase, color) {
  const h = yBase - yTop;
  if (h <= 0.5) return "";
  const r = Math.min(4, w / 2, h);
  return `<path d="M${x.toFixed(1)},${yBase.toFixed(1)} V${(yTop + r).toFixed(1)} Q${x.toFixed(1)},${yTop.toFixed(1)} ` +
    `${(x + r).toFixed(1)},${yTop.toFixed(1)} H${(x + w - r).toFixed(1)} Q${(x + w).toFixed(1)},${yTop.toFixed(1)} ` +
    `${(x + w).toFixed(1)},${(yTop + r).toFixed(1)} V${yBase.toFixed(1)} Z" fill="${color}"/>`;
}

export function columnChart(labels, values, { width = 680, height = 220, labelEvery = 1, axisFont = 10,
  refValue = null, title = "" } = {}) {
  const left = 12 + axisFont * 4, right = 8, top = 12, bottom = 14 + axisFont * 2;
  const plotW = width - left - right, plotH = height - top - bottom;
  const ticks = niceTicks(Math.max(0, ...values, refValue || 0));
  const yMax = ticks[ticks.length - 1];
  const slot = plotW / Math.max(values.length, 1);
  const barW = Math.min(24, Math.max(slot - 2, 1));
  const yBase = top + plotH;
  const p = [`<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}" ` +
    `xmlns="http://www.w3.org/2000/svg" style="font-family: inherit; font-variant-numeric: tabular-nums;">`];
  for (const t of ticks) {
    const y = yBase - (t / yMax) * plotH;
    p.push(`<line x1="${left}" x2="${width - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${t === 0 ? BASELINE : GRID}" stroke-width="1"/>`);
    p.push(`<text x="${left - 6}" y="${(y + axisFont * 0.35).toFixed(1)}" text-anchor="end" font-size="${axisFont}" fill="${MUTED}">${fmtNum(t)}</text>`);
  }
  values.forEach((v, i) => {
    const x = left + i * slot + (slot - barW) / 2;
    const yTop = yMax ? yBase - (v / yMax) * plotH : yBase;
    p.push(`<g><title>${esc(labels[i])}: ${Math.round(v).toLocaleString("en-GB")}</title>${column(x, yTop, barW, yBase, SERIES)}</g>`);
    if (i % labelEvery === 0) {
      p.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${yBase + axisFont + 8}" text-anchor="middle" font-size="${axisFont}" fill="${MUTED}">${esc(labels[i])}</text>`);
    }
  });
  if (refValue) {
    const y = yBase - (refValue / yMax) * plotH;
    p.push(`<line x1="${left}" x2="${width - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${REF}" stroke-width="2"/>`);
  }
  p.push("</svg>");
  return p.join("");
}
