# The Pond: Leapfrog Advertising's internal platform

_The Pond_ is the platform's name (header, browser tab, favicon `public/icon.png`): Campaign Board, Marketing Planner and Billboard Reporting.

A Cloudflare Worker (static assets + a small API + D1 database) showing the
same Campaign Board, with shared, synced data instead of per-browser
localStorage.

> **Note on naming:** Cloudflare's dashboard now shows this as a "Worker"
> project, not "Pages" — Cloudflare merged the two systems, and a
> Git-connected static site with an API is what that unified system calls a
> "Worker with static assets." Functionally it's exactly what you'd expect
> from "Pages": a static site + API, deployed from Git. The distinction only
> matters for which dashboard screens you use (see below).

This deploys straight from a GitHub repo: **every time you `git push`,
Cloudflare rebuilds and redeploys automatically.** In practice, that means
you can ask Claude to make a change in a future session, Claude commits and
pushes, and the live site updates within about 30 seconds — no terminal
commands, no Wrangler CLI, no Node.js required on your end at all.

Access is locked down with **Cloudflare Access**, gated to your company
email domain — there is no point where the URL is reachable without signing
in with a matching email.

Total cost: **$0** on Cloudflare's free tier for a team this size.

---

## 1. Create a private GitHub repo (2 minutes, no installs)

1. Go to <https://github.com/new> (create a free GitHub account first at
   <https://github.com/signup> if you don't have one).
2. Repository name: whatever you like (this project used
   `Campaign-Planning-Platform`).
3. Set it to **Private**.
4. Do **not** check "Add a README" or any other init option — an empty repo
   avoids a merge conflict with the code you're about to push.
5. Click **Create repository**, then copy the HTTPS URL shown under "…or
   push an existing repository from the command line."

## 2. Push the code (one-time — the only Terminal step)

Open **Terminal** (Spotlight → "Terminal"), then:

```bash
cd ~/Downloads/leapfrog-campaign-app
git remote add origin <your-repo-url>.git
git branch -M main
git push -u origin main
```

The first push prompts for GitHub credentials — GitHub only accepts a
**Personal Access Token** here, never your account password (Google-SSO
accounts included — the token is a separate credential type from how you
sign into github.com):

1. Create one at <https://github.com/settings/personal-access-tokens/new>.
2. "Repository access" → "Only select repositories" → this repo.
3. "Permissions" → "Repository permissions" → Contents → **Read and
   write**. Generate, copy it.
4. When Terminal asks for a password, paste the token (it pastes invisibly —
   that's normal).

macOS will offer to remember it in Keychain — say yes, so future pushes
(including ones Claude runs for you) just work without asking again.

## 3. Connect Cloudflare to the repo

1. Create a free account at <https://dash.cloudflare.com/sign-up> if you
   haven't already.
2. Dashboard → **Compute (Workers)** (or however your sidebar labels it —
   Cloudflare has renamed this section a few times) → **Create** →
   **Connect to Git** (sometimes under an "Import a repository" option).
3. Authorize Cloudflare's GitHub App, scoped to this repo specifically.
4. Cloudflare reads `wrangler.toml` in the repo automatically — it already
   declares the Worker entry point (`worker/index.js`), the static assets
   directory (`public/`), and the D1 binding, so there's nothing to
   configure by hand in the build settings. Click through to deploy.
5. You'll get a URL like `https://leapfrog-campaign-board.<subdomain>.workers.dev`
   — **don't share it yet**, it's wide open until step 5.

## 4. Create and seed the database — dashboard console, no CLI

1. Dashboard sidebar → **Storage & Databases** → **D1** → **Create
   Database**. Name it `leapfrog_campaigns`.
2. On the database's **Overview** tab, copy the **Database ID** (a UUID) —
   paste it into `wrangler.toml` in this repo, replacing
   `REPLACE_WITH_ID_FROM_D1_DASHBOARD`, then commit and push. This is the
   one manual edit needed — **for a Git-connected Worker, bindings live in
   `wrangler.toml`, not in the dashboard's Bindings screen** (that screen
   won't let changes stick, by design — code is the source of truth here).
3. Back on the database → **Console** tab: paste the contents of
   **`schema.console.sql`** (not `schema.sql`) into the query box and run
   it. Use the `.console.sql` versions specifically — the dashboard console
   has pasted multi-line SQL as a single squashed line in practice, and
   since `schema.sql`/`seed.sql` use `--` line comments, a squashed paste
   turns the very first comment into one giant comment swallowing the
   entire rest of the file (D1 then reports "no query"). The `.console.sql`
   files are the same SQL with comments stripped, so that failure mode
   can't happen regardless of how the console handles line breaks.
4. Paste the contents of **`seed.console.sql`** and run it — loads your 94
   existing campaigns in one go.
5. Push the `wrangler.toml` change from step 2 (if not already done) —
   Cloudflare redeploys automatically and picks up the binding.

## 5. Lock it down with Cloudflare Access — do this before sharing the link

1. **Zero Trust** → **Access** → **Applications** → **Add an application**
   → **Self-hosted**.
2. Application domain: your Worker's URL, path `/` so it covers the API
   routes too.
3. Add a policy: **Include** → **Emails ending in** →
   `@leapfrogadvertising.com` (or list individual emails instead).
4. Save. Free for up to 50 users.

Now the link is safe to share with your team — anyone opening it has to
sign in with a matching email first.

---

## Making changes from here on

Just ask Claude, in a Claude Code session opened in this folder (or pointed
at `~/Downloads/leapfrog-campaign-app`), to make the change. Claude edits
the files, commits, and runs `git push` — Cloudflare picks up the push
automatically and redeploys within seconds. You never need to touch
Wrangler, Node, or the Cloudflare dashboard again for ordinary changes.

The dashboard is still where you'd go for infra-level things — checking D1
data directly, changing the Access policy, adding a custom domain — but
day-to-day feature/styling changes are just "ask Claude, then check the live
site."

---

## Project layout

- `public/` — the static front-end (HTML/CSS/JS, fonts, logo). Served
  directly by Cloudflare's asset handler for any request that isn't under
  `/api/`.
- `worker/index.js` — the one Worker script handling all `/api/campaigns...`
  routes (list, create, update, archive/restore, bulk import), falling back
  to static assets for everything else.
- `worker/utils.js` — small shared helpers used by `worker/index.js`.
- `schema.sql` / `seed.sql` — D1 table definition and your migrated
  historical campaign data; run once via the D1 dashboard console.
- `wrangler.toml` — the actual config Cloudflare reads on every deploy:
  Worker entry point, static assets directory, and the D1 binding. This is
  the one file where infra config lives — edit it (and push) rather than
  trying to change bindings from the dashboard.

---

## What changed from the artifact version

- Data lives in a real database (Cloudflare D1) instead of each browser's
  localStorage. Every add/edit/delete/archive/restore/import calls the small
  API in `worker/index.js`.
- The board polls the API every 20 seconds (only while the tab is visible
  and no modal is open) so teammates' changes show up without a manual
  reload.
- Fonts and the logo are normal static files under `public/` instead of
  inlined as base64.
- "Export backup" uses a normal browser download instead of the Claude
  Artifact download API, since this is a plain static site now.
- The Analytics page (inventory-over-time charts) is unchanged.
- The API was originally written as Cloudflare Pages Functions
  (`functions/api/...`, one file per route) but this project turned out to
  be Cloudflare's unified "Worker with static assets" type rather than
  classic Pages, which doesn't use that file-based convention — it's been
  consolidated into `worker/index.js` instead, with identical behavior.

---

## Billboard Reporting tab

Client campaign reports for the DOOH screens: plays from **Navori QL**, potential impressions
from **Datajam** JamBoxes, and agreed vs delivered plays. Ported from the local Python tool in
`~/Downloads/leapfrog-campaign-reports`; same definitions, and verified to give identical numbers.

**One-off setup: add four secrets** (Cloudflare dashboard → Workers & Pages →
`campaign-planning-platform` → Settings → Variables and Secrets → Add → type **Secret**):

| Name | Value |
|---|---|
| `NAVORI_USERNAME` | Navori QL login |
| `NAVORI_PASSWORD` | Navori QL password |
| `DATAJAM_EMAIL` | Datajam portal email |
| `DATAJAM_PASSWORD` | Datajam portal password |

Secrets survive Git deploys; plain "Text" variables do **not** (each push wipes them). Don't put
them in `wrangler.toml`. Until they're added, the tab shows a banner and can't fetch numbers.
`/api/billboard/status` lists which setting *names* the Worker can see (never values).

Easiest way to (re)set them from this Mac, reading straight from the local tool's `.env`:
```bash
wrangler login
for k in NAVORI_USERNAME NAVORI_PASSWORD DATAJAM_EMAIL DATAJAM_PASSWORD; do ~/Downloads/leapfrog-campaign-reports/.venv/bin/python -c "import sys; from dotenv import dotenv_values; sys.stdout.write(dotenv_values('$HOME/Downloads/leapfrog-campaign-reports/.env')['$k'])" | wrangler secret put "$k" --name campaign-planning-platform; done
```
(`--name campaign-planning-platform` matters: `wrangler.toml`'s `name` is the old, unused one. Read the
values with python-dotenv: the passwords are single-quoted in `.env`.)

**Files**
- `worker/billboard.js`: API under `/api/billboard/*`. Creates its own D1 tables on first use
  (`billboard_screens`, `billboard_campaigns`, `billboard_photos`) and seeds the 6 screens with
  their agreed rates plus the National Waterfront Museum campaign. It only stores settings and
  fetches raw rows; the maths runs in the browser.
- `public/billboard/`: the tab (`billboard.js`, `billboard.css`), the numbers (`model.js`), the
  report (`report.html`, `report.js`, `report.css`, `charts.js`) and the report logo.

**How the report becomes a PDF:** "Open report / Save as PDF" opens `/billboard/report.html`,
built as 16:9 slides that copy the Google Slides report. Its **Save as PDF** button opens the
browser's print window: choose *Save as PDF* (Chrome/Edge). The file name is filled in for you.

**Gotchas**
- Navori ties a login token to the client IP, and Worker `fetch()` can leave Cloudflare from different
  IPs, which gave `NOT_CONNECTED` in production (it worked locally). All Navori calls therefore go down
  ONE keep-alive TLS socket (`KeepAliveHttps`), sharing one login; on `NOT_CONNECTED` it logs in once more.
- Datajam only accepts **GET with a JSON body**, which `fetch()` in Workers refuses to send.
  `datajamGet()` writes the HTTP request by hand over a TLS socket (`cloudflare:sockets`). It
  stops reading once the full response has arrived, because Datajam's server drops the
  connection abruptly (the runtime reports "Network connection lost").
- Navori `GetReportings`: use `GroupByDate=false, GroupByGroup=false` (true *merges* rows).
  Durations are in milliseconds.
- Agreed plays per week are stored **per screen**. A location's total is the sum of its screens
  (Parc Tawe 15,960 = 2 × 7,980; WMC 17,640 = 3 × 5,880).

**Local testing** (no secrets in the repo; Access bypass only via the command line):
```bash
wrangler dev --local --env-file ~/Downloads/leapfrog-campaign-reports/.env --var DEV_LOCAL_EMAIL:local-test
```

---

## Notifications (bell in the top bar)

`worker/notifications.js` creates notifications; `public/notifications/` shows them. Each notification has a unique
key so it's only created once; read/unread is per person (Access email). Click one to open the campaign on the
board, the report in Billboard Reporting, or the Billboard Screens tab. "Turn on pop-ups" in the panel enables
browser pop-ups while the app is open.

| Notification | When |
|---|---|
| New report to do | a finished board campaign became a Billboard report to-do |
| Report overdue | a report is still to-do 7 days after its campaign ended |
| Goes live tomorrow / Do the proofs / Ends tomorrow | a booking starts tomorrow / starts today / ends tomorrow ("To Hold" excluded) |
| Artwork still missing | starts within 3 days and still "Awaiting Artwork" / "Awaiting Approval" |
| On hold 7+ days | "To Hold" for 7+ days (hold start = first seen on hold; its last edit for older holds) |
| Overbooked | confirmed slots above a venue's capacity (WMC 9, Quadrant 18, Parc Tawe 18; keep `CAPACITY` in step with `LOCATIONS`) |
| Screen offline / back online | a Navori player hasn't checked in for 2+ hours |
| JamBox offline / back online | a JamBox in use is Disabled or not seen for 24+ hours |
| Behind on plays | once each morning (after 08:00 UK): a live report with artworks and a package is behind its agreed pace; at most every 3 days |

Campaign rules run whenever someone loads the app (cheap: database only) and every 15 minutes on the Cloudflare
schedule (`[triggers]` in `wrangler.toml`), which also runs the Navori/Datajam checks.
