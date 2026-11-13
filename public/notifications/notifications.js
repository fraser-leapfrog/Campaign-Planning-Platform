// Notifications bell (top bar). Polls /api/notifications every minute, shows an unread count,
// a dropdown list, and (if allowed) a browser pop-up for anything new. Clicking a notification
// opens the campaign on the board, the report in Billboard Reporting, or the Screens tab.
// The rules that create notifications live in worker/notifications.js.

const POLL_MS = 60000;
const POPPED_KEY = "leapfrog.notifications.popped";   // per browser: ids already shown as pop-ups

const ICONS = {
  "new-report": "📝", overdue: "⏰", "live-tomorrow": "🗓️", proofs: "📸", ending: "🏁", artwork: "🎨", hold: "⏸️",
  overbooked: "⚠️", "screen-offline": "📺", "screen-online": "✅", "jambox-offline": "📡", "jambox-online": "✅",
  underdelivery: "📉",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (id) => document.getElementById(id);

let items = [];
let open = false;
let firstLoad = true;

function ago(isoTime) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(isoTime)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function popped() {
  try { return new Set(JSON.parse(localStorage.getItem(POPPED_KEY) || "[]")); } catch (_) { return new Set(); }
}
function savePopped(set) {
  try { localStorage.setItem(POPPED_KEY, JSON.stringify([...set].slice(-500))); } catch (_) { /* storage blocked */ }
}

async function load() {
  let data;
  try {
    const res = await fetch("/api/notifications", { cache: "no-store" });
    if (!res.ok) return;
    data = await res.json();
  } catch (_) { return; }   // offline or signed out: keep what we have
  items = data.items || [];
  renderCount(data.unread || 0);
  if (open) renderPanel();
  popUps();
  firstLoad = false;
}

function renderCount(n) {
  const c = $("notif-count");
  c.hidden = n === 0;
  c.textContent = n > 99 ? "99+" : String(n);
  $("notif-bell").setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
}

function popUps() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const seen = popped();
  // On the first load after opening the app, don't flood: only pop things from the last hour.
  const fresh = items.filter((n) => !n.read && !seen.has(n.id)
    && (!firstLoad || Date.now() - Date.parse(n.created_at) < 3600e3));
  for (const n of fresh.slice(0, 3)) {
    try {
      const p = new Notification(n.title, { body: n.body, tag: `leapfrog-${n.id}`, icon: "/icon.png" });
      p.onclick = () => { window.focus(); go(n); p.close(); };
    } catch (_) { /* pop-ups unsupported here */ }
  }
  for (const n of items) if (!n.read) seen.add(n.id);
  savePopped(seen);
}

function renderPanel() {
  const unread = items.filter((n) => !n.read);
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const row = (n) => `
    <button type="button" class="notif-item${n.read ? "" : " unread"}" data-id="${n.id}">
      <span class="notif-icon" aria-hidden="true">${ICONS[n.kind] || "🔔"}</span>
      <span class="notif-text"><span class="notif-title">${esc(n.title)}</span>
        <span class="notif-body">${esc(n.body)}</span><span class="notif-time">${esc(ago(n.created_at))}</span></span>
    </button>`;
  $("notif-panel").innerHTML = `
    <div class="notif-head"><strong>Notifications</strong>
      ${unread.length ? `<button type="button" class="notif-link" data-notif-act="all">Mark all read</button>` : ""}</div>
    ${perm === "default" ? `<div class="notif-pop">Get a pop-up when something new arrives (while the app is open).
        <button type="button" class="notif-link" data-notif-act="popups">Turn on pop-ups</button></div>` : ""}
    ${perm === "denied" ? `<div class="notif-pop">Pop-ups are blocked for this site in your browser settings.</div>` : ""}
    <div class="notif-list">${items.length ? items.map(row).join("") : `<div class="notif-empty">You're all caught up.</div>`}</div>`;
}

async function markRead(body) {
  try {
    await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (_) { /* next poll will tidy up */ }
}

function go(n) {
  if (!n.read) { n.read = true; markRead({ ids: [n.id] }); renderCount(items.filter((x) => !x.read).length); }
  setOpen(false);
  const board = window.LeapfrogBoard;
  if (n.link_type === "report" && window.Billboard) window.Billboard.openReport(n.link_id);
  else if (n.link_type === "screens" && window.Billboard) window.Billboard.openScreens();
  else if (n.link_type === "board" && board) {
    if (n.link_id) board.openCampaign(n.link_id) || board.showPage("campaign");
    else board.showAnalytics();
  }
}

function setOpen(v) {
  open = v;
  $("notif-panel").hidden = !v;
  $("notif-bell").setAttribute("aria-expanded", String(v));
  if (v) renderPanel();
}

function init() {
  const bell = $("notif-bell");
  if (!bell) return;
  bell.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!open); });
  $("notif-panel").addEventListener("click", async (e) => {
    e.stopPropagation();
    const act = e.target.closest("[data-notif-act]");
    if (act && act.dataset.notifAct === "all") {
      items.forEach((n) => { n.read = true; });
      renderCount(0); renderPanel();
      await markRead({ all: true });
      return;
    }
    if (act && act.dataset.notifAct === "popups") {
      try { await Notification.requestPermission(); } catch (_) { /* ignore */ }
      if (Notification.permission === "granted") savePopped(new Set(items.map((n) => n.id)));   // only new ones from now on
      renderPanel();
      return;
    }
    const item = e.target.closest(".notif-item");
    if (item) go(items.find((n) => String(n.id) === item.dataset.id));
  });
  document.addEventListener("click", () => { if (open) setOpen(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) setOpen(false); });
  load();
  setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
}

init();
