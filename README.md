# SiteCloner (Next.js, Vercel-ready)

Paste a website URL → live folder tree + file preview → **Download ZIP**. Every clone is logged in an activity history.

## Output layout (inside the ZIP)

```
example.com/
├─ index.html            (start page)
├─ about.html, blog/index.html …   (other pages)
├─ css/   js/   images/   fonts/   media/   assets/
├─ clone-report.json     (page map + failed downloads)
└─ README-DEPLOY.txt
```
All links / CSS `url()` / `@import` / `srcset` are rewritten to relative paths, so `index.html` opens offline.

## Run locally

```bash
npm install
cp .env.example .env.local     # set APP_PASSWORD
npm run dev                     # http://localhost:3000
```
To test against a site on localhost add `ALLOW_PRIVATE=1` to `.env.local` (never on Vercel).

## Deploy on Vercel

1. Push this folder to GitHub → Vercel → **Add New Project** → import it (framework: Next.js, no settings needed).
2. **Settings → Environment Variables**: add `APP_PASSWORD` (login prompt for the whole app; username can be anything).
3. **Storage / Marketplace → Upstash Redis → Connect to project**. It injects `KV_REST_API_URL` / `KV_REST_API_TOKEN`, which turns on the permanent activity log. Redeploy.
4. Optional: `BROWSERLESS_TOKEN` (+ tick "Render JS") for React/Next/Vue sites.

Hobby plan: function limit is 300 s (`maxDuration = 300`, crawl stops itself at `CLONE_MAX_SECONDS`, default 270 s). Files are streamed to the browser and zipped there, so the 4.5 MB response limit does not apply.

## Safeguards built in
- Password gate (`APP_PASSWORD`)
- SSRF protection: localhost, private IPs and metadata endpoints are blocked, including on redirects
- Mandatory "I have permission" confirmation, stored in the log
- Caps: 8 MB per file, 120 MB total, 100 pages (all configurable via env)

## Known limits
- Only the front-end is copied (no server code, databases, logins, form handling, API data).
- JavaScript-rendered sites need "Render JS" (Browserless); otherwise you get the empty shell.
- Links inside JS files (dynamic imports, fetch URLs) are not rewritten.
- Only copy sites you own or have permission for.
