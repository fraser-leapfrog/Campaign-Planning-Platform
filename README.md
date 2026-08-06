# Leapfrog Campaign Board — internal deploy

A Cloudflare Pages site (static front-end + Pages Functions API + D1 database)
that shows the exact Campaign Board you've been using, but with shared,
synced data instead of per-browser localStorage — everyone on the team sees
the same campaigns and edits.

Access is locked down with **Cloudflare Access**, gated to your company email
domain. There is no public URL that works without signing in with a
`@leapfrogadvertising.com` account (or whichever emails you allow) — it is not
reachable by the public at any point in this setup.

Total cost: **$0** on Cloudflare's free tier for a team this size (Pages,
Functions, and D1 are all free within generous limits; Access is free for
your first 50 users).

---

## 0. Install prerequisites (one-time, on your Mac)

You don't have Node.js installed yet. Get it first:

```bash
brew install node
```

If you don't have Homebrew either, install it from <https://brew.sh> first
(it'll print the exact command to run), then run the line above.

Confirm it worked:

```bash
node --version
npm --version
```

---

## 1. Create your Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up> and create a free account
   with your work email.
2. You do **not** need a domain for this — Cloudflare Pages gives you a free
   `*.pages.dev` subdomain, and Access can gate that just fine. (You can add
   your own domain later if you want a nicer URL.)

---

## 2. Install Wrangler and log in

From this project's folder:

```bash
npm install -g wrangler
wrangler login
```

This opens a browser tab — approve it there. `wrangler` is Cloudflare's CLI;
everything below runs through it.

---

## 3. Create the database and load your existing campaigns

```bash
wrangler d1 create leapfrog_campaigns
```

This prints a block like:

```
[[d1_databases]]
binding = "DB"
database_name = "leapfrog_campaigns"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy that `database_id` value into `wrangler.toml` in this folder, replacing
`REPLACE_WITH_ID_FROM_WRANGLER_D1_CREATE`.

Then create the table and load your 94 existing campaigns (the same data
that's in the current board) into it:

```bash
wrangler d1 execute leapfrog_campaigns --remote --file=./schema.sql
wrangler d1 execute leapfrog_campaigns --remote --file=./seed.sql
```

---

## 4. Deploy

```bash
wrangler pages deploy public --project-name=leapfrog-campaign-board
```

First run will ask to create the Pages project — say yes. It prints a URL
like `https://leapfrog-campaign-board.pages.dev` — that's your team's link,
**but don't share it yet** until Access is set up in the next step (right
now it would be reachable by anyone with the link).

The D1 binding you set in `wrangler.toml` is picked up automatically for the
`functions/` API routes on this same deploy.

---

## 5. Lock it down with Cloudflare Access — do this before sharing the link

1. In the Cloudflare dashboard, go to **Zero Trust** → **Access** →
   **Applications** → **Add an application** → **Self-hosted**.
2. Application domain: pick your Pages URL
   (`leapfrog-campaign-board.pages.dev`) — leave the path as `/` so it
   covers the whole app, API included.
3. Add a policy: **Include** → **Emails ending in** → `@leapfrogadvertising.com`
   (swap in whatever your team's real domain is, or list specific emails if
   you'd rather allow-list individuals instead of the whole domain).
4. Save. Cloudflare Access is free for up to 50 users on the free plan.

From now on, anyone opening that URL has to sign in (via a one-time email
code, Google SSO, or whatever identity provider you connect) and only
matching emails get through. Everyone else gets a login wall, not the app —
this is what makes it genuinely private rather than "unlisted."

Now the link is safe to share with your team.

---

## 6. Updating it later

Any time you want to change the board itself (new features, styling, etc.),
edit `public/index.html` and redeploy:

```bash
wrangler pages deploy public --project-name=leapfrog-campaign-board
```

Data lives in D1 independently of the deploy, so redeploying the front-end
never touches existing campaigns.

To inspect or hand-edit data directly:

```bash
wrangler d1 execute leapfrog_campaigns --remote --command="SELECT * FROM campaigns LIMIT 5"
```

---

## What changed from the artifact version

- Data now lives in a real database (Cloudflare D1) instead of each
  browser's localStorage. Every add/edit/delete/archive/restore/import calls
  a small API (`functions/api/campaigns/...`) instead of writing locally.
- The board polls the API every 20 seconds (only while the tab is visible
  and no modal is open) so teammates' changes show up without a manual
  reload.
- Fonts and the logo are now normal static files under `public/` instead of
  inlined as base64 — same look, smaller page.
- The "Export backup" button now uses a normal browser download instead of
  the Claude Artifact download API, since this is a plain static site — it
  still downloads a full JSON snapshot of every row, same as before.
- The Analytics page (inventory-over-time charts) is unchanged.
