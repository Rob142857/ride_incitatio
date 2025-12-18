# Ride Trip Planner

Trip planning and sharing built on Cloudflare Pages + Workers. The frontend lives in `public/` and the authenticated API lives under `api/` with D1 for data, KV for sessions, and R2 for attachments.

## Features (current)

- SSO login (Google, Facebook, Microsoft) with sessions in KV
- Authenticated trips with waypoints, journal entries, attachments (R2), and cover images
- Public sharing via 6-char short codes; “Use this trip” import flow into your account
- Export to JSON/GPX; import resumes after login if started from a shared link
- Refresh controls for trips, journal, and waypoints to bust cache in UI
- About/legal pages (privacy, terms, deletion) and self-service data purge page with auth + confirmation

## Project Structure

```
api/
  auth.js       # OAuth handlers and session lifecycle
  router.js     # Minimal router
  trips.js      # Trips, waypoints, journal, attachments, sharing, purge
  utils.js      # CORS, auth middleware, helpers
  worker.js     # Entry point wiring routes
  schema.sql    # D1 schema
public/
  index.html    # Main app shell (authenticated)
  trip.html     # Public/shared trip view + import
  view.html     # Legacy viewer
  deletion.html # Self-serve purge with re-auth + DELETE confirmation
  privacy.html, terms.html, admin.html, etc.
  css/          # app.css, global.css
  js/           # api.js client, app.js, map.js, ui.js, storage.js, share.js, trip.js
docs/
  osrm-azure.md
scripts/
  regen-share.js
wrangler.toml     # Cloudflare Pages/Workers config
DEPLOY.md         # Deployment guide (D1/KV/R2/OAuth setup)
```

## Local Development

Requirements: Node 18+, Wrangler CLI, Cloudflare account.

1) Install deps:
```bash
npm install
```

2) Configure Cloudflare bindings (see `DEPLOY.md` for details):
- D1 database bound as `DB`
- KV namespace bound as `SESSIONS`
- R2 bucket bound as `ATTACHMENTS`
- OAuth secrets: GOOGLE_CLIENT_ID/SECRET, FACEBOOK_APP_ID/SECRET, MICROSOFT_CLIENT_ID/SECRET

3) Run migrations:
```bash
npm run db:migrate      # uses api/schema.sql
```

4) Develop against Cloudflare stack:
```bash
npm run dev:remote      # pages dev with D1, KV bindings
```

Static-only preview (no API):
```bash
npm start               # serves public/ at http://localhost:3000
```

## API Notes

- Auth routes: `/api/auth/login/:provider`, `/api/auth/callback/:provider`, `/api/auth/me`, `/api/auth/logout`
- Trip data: `/api/trips` (CRUD), `/api/trips/:id/waypoints`, `/api/trips/:id/journal`, `/api/trips/:id/attachments`
- Sharing: `/api/trips/:id/share` generates/returns short code; public fetch `/api/s/:shortCode`
- Attachments stream from R2 via `/api/attachments/:id`
- Self-serve purge: `POST /api/user/purge` deletes user trips/waypoints/journal/attachments and R2 objects

## Frontend Notes

- About modal links: privacy/terms/deletion plus repo link (Source)
- Deletion page requires login, typing `DELETE`, and confirmation before purge
- Import flow on shared trip page prompts login, then creates a copy into your account

## Deployment

See `DEPLOY.md` for Cloudflare Pages/Workers steps (create D1, KV, R2, add secrets, `npm run deploy`).

## License

MIT
