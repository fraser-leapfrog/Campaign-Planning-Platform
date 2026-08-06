# Leapfrog Campaign Board — internal deploy (GitHub + Cloudflare Pages)

A Cloudflare Pages site (static front-end + Pages Functions API + D1
database) showing the same Campaign Board, with shared, synced data instead
of per-browser localStorage.

This version deploys straight from a GitHub repo: **every time you `git
push`, Cloudflare rebuilds and redeploys automatically.** In practice, that
means you can ask Claude to make a change in a future session, Claude
commits and pushes, and the live site updates within about 30 seconds —
no terminal commands, no Wrangler CLI, no Node.js required on your end at
all.

Access is locked down with **Cloudflare Access**, gated to your company
email domain — there is no point where the URL is reachable without signing
in with a matching email.

Total cost: **$0** on Cloudflare's free tier for a team this size.

The code is already a git repo on this Mac with one commit in it
(`git log` in this folder will show it). The steps below get it onto GitHub
and connected to Cloudflare — everything from here on is clicking around in
two websites, plus one one-time login in Terminal.

---

## 1. Create a private GitHub repo (2 minutes, no installs)

1. Go to <https://github.com/new> (create a free GitHub account first at
   <https://github.com/signup> if you don't have one).
2. Repository name: `leapfrog-campaign-board`.
3. Set it to **Private**.
4. Do **not** check "Add a README" or any other init option — this repo
   already has files, an empty one avoids a conflict.
5. Click **Create repository**. On the next page, copy the URL under
   "…or push an existing repository from the command line" — it looks like
   `https://github.com/<your-username>/leapfrog-campaign-board.git`.

## 2. Push the code (one-time — this is the only Terminal step)

Open **Terminal** (Spotlight → "Terminal"), then:

```bash
cd ~/Downloads/leapfrog-campaign-app
git remote add origin https://github.com/<your-username>/leapfrog-campaign-board.git
git branch -M main
git push -u origin main
```

Swap in your actual repo URL from step 1. The first push will prompt for
GitHub credentials in the terminal — GitHub no longer accepts your account
password here, so when asked:

- **Username:** your GitHub username
- **Password:** a **Personal Access Token**, not your real password — create
  one at <https://github.com/settings/personal-access-tokens/new>: give it
  a name, set expiration to whatever you're comfortable with, under
  "Repository access" pick "Only select repositories" → this repo, and
  under "Permissions" → "Repository permissions" → Contents → **Read and
  write**. Generate it, copy it, paste it as the password when Terminal
  asks. (macOS will offer to remember it in Keychain — say yes, so you
  never have to do this again, and so future git pushes — including ones
  Claude runs for you — just work.)

Once this succeeds, refresh the GitHub repo page in your browser — you
should see all the project files there.

## 3. Connect Cloudflare Pages to the repo

1. Go to <https://dash.cloudflare.com/sign-up> and create a free account if
   you haven't already (your work email is fine).
2. In the dashboard sidebar: **Workers & Pages** → **Create** → **Pages**
   tab → **Connect to Git**.
3. Authorize Cloudflare's GitHub App when prompted, and grant it access to
   the `leapfrog-campaign-board` repo specifically (not all repos, unless
   you're fine with that).
4. Select the repo, then set build settings:
   - **Framework preset:** None
   - **Build command:** *(leave blank)*
   - **Build output directory:** `public`
5. Click **Save and Deploy**. First deploy takes under a minute. You'll get
   a URL like `https://leapfrog-campaign-board.pages.dev` — **don't share
   it yet**, it's wide open until step 5.

## 4. Create and seed the database — all in the dashboard, no CLI

1. In the Cloudflare dashboard: **Workers & Pages** → **D1 SQL Database** →
   **Create Database**. Name it `leapfrog_campaigns`.
2. Open the new database → **Console** tab. Paste the contents of
   `schema.sql` (in this folder) into the query box and run it.
3. Then paste the contents of `seed.sql` and run it — this loads your 94
   existing campaigns in one go.
4. Go back to your Pages project → **Settings** → **Functions** → **D1
   database bindings** → **Add binding**:
   - Variable name: `DB`
   - D1 database: `leapfrog_campaigns`
5. Save, then go to **Deployments** and **Retry deployment** on the latest
   one (bindings only take effect on a fresh deploy).

## 5. Lock it down with Cloudflare Access — do this before sharing the link

1. **Zero Trust** → **Access** → **Applications** → **Add an application**
   → **Self-hosted**.
2. Application domain: your Pages URL (`leapfrog-campaign-board.pages.dev`),
   path `/` so it covers the API routes too.
3. Add a policy: **Include** → **Emails ending in** →
   `@leapfrogadvertising.com` (or list individual emails instead).
4. Save. Free for up to 50 users.

Now the link is safe to share with your team — anyone opening it has to
sign in with a matching email first.

---

## Making changes from here on

Just ask Claude, in a Claude Code session opened in this folder (or point it
at `~/Downloads/leapfrog-campaign-app`), to make the change. Claude edits
the files, commits, and runs `git push` — Cloudflare picks up the push
automatically and redeploys within seconds. You never need to touch
Wrangler, Node, or the Cloudflare dashboard again for ordinary changes.

The dashboard is still where you'd go for infra-level things — checking
D1 data directly, changing the Access policy, adding a custom domain — but
day-to-day feature/styling changes are just "ask Claude, then check the
live site."

---

## What changed from the artifact version

- Data lives in a real database (Cloudflare D1) instead of each browser's
  localStorage. Every add/edit/delete/archive/restore/import calls a small
  API (`functions/api/campaigns/...`).
- The board polls the API every 20 seconds (only while the tab is visible
  and no modal is open) so teammates' changes show up without a manual
  reload.
- Fonts and the logo are normal static files under `public/` instead of
  inlined as base64.
- "Export backup" uses a normal browser download instead of the Claude
  Artifact download API, since this is a plain static site now.
- The Analytics page (inventory-over-time charts) is unchanged.
- `wrangler.toml` is still in the repo for reference (e.g. if you ever want
  to inspect D1 from the CLI later), but nothing in this deploy path
  requires Wrangler, Node, or npm.
