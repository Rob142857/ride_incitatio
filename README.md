# Ride Trip Planner

A mobile-first PWA for planning and navigating trips — built on Cloudflare Workers with D1, KV, and R2. The glassmorphic frontend lives in `public/` and the authenticated API lives under `api/`.

## Features

- **SSO login** — Google and Microsoft OAuth with sessions in KV
- **Trip management** — waypoints (stop, scenic, fuel, food, lodging, custom), journal entries, and file attachments stored in R2
- **Cover images** — upload or pick from trip photos; focal-point selector for responsive cropping
- **Turn-by-turn navigation** — ride mode with live GPS, auto-reroute when off-course, and routing from your current position to the first waypoint via self-hosted OSRM
- **Public sharing** — 6-char short codes; public trip page with cover hero, itinerary, gallery, and "Use this trip" import
- **Export / import** — JSON and GPX; import resumes after login if started from a shared link
- **PWA install prompt** — captures `beforeinstallprompt` and shows a native-feel banner on mobile
- **Live refresh** — service worker polls `/api/_build`; on deploy, caches are purged and clients reload seamlessly
- **Offline support** — network-first app shell with cache fallback; stale-while-revalidate map tiles
- **Trip versioning** — DB triggers auto-bump `version` on any mutation; client polls `/api/trips/versions` for staleness
- **Self-service data purge** — deletion page with re-auth + typed confirmation

## Project Structure

```
api/
  auth.js          # OAuth handlers and session lifecycle
  places.js        # Place search (Nominatim proxy)
  router.js        # Minimal request router
  trips.js         # Trips, waypoints, journal, attachments, sharing, purge
  utils.js         # CORS, auth middleware, helpers
  worker.js        # Entry point — routes, BUILD_ID, security headers
  schema.sql       # D1 schema
  migrations/      # Incremental SQL migrations
public/
  index.html       # Main app shell (authenticated)
  trip.html        # Public/shared trip view + import
  view.html        # Legacy viewer
  deletion.html    # Self-serve purge with re-auth + DELETE confirmation
  privacy.html, terms.html, admin.html
  sw.js            # Service worker — build-aware caching
  manifest.json    # PWA manifest
  css/             # app.css, global.css
  js/
    api.js              # API client
    app.js, app-core.js # App bootstrap + core logic
    auth-controller.js  # Auth state machine
    trip-controller.js  # Trip CRUD, cover picker
    waypoint-controller.js
    journal-controller.js
    ride-controller.js  # Navigation mode, GPS, rerouting
    map.js              # Leaflet, OSRM routing, tile prefetch
    ui.js               # Modals, toasts, menus, panels
    storage.js          # Local storage helpers
    share.js            # Share page renderer
    trip.js, utils.js
  icons/
docs/
  osrm-azure.md    # Self-hosted OSRM on Azure
  billing-plan.md
scripts/
  deploy.js        # Auto-bump BUILD_ID + wrangler deploy
  regen-share.js   # Regenerate share codes
wrangler.toml      # Cloudflare Workers config
DEPLOY.md          # Full deployment guide
```

## Local Development

Requirements: Node 18+, Wrangler CLI, Cloudflare account.

```bash
npm install
```

Configure Cloudflare bindings (see `DEPLOY.md`):
- D1 database → `RIDE_TRIP_PLANNER_DB`
- KV namespace → `RIDE_TRIP_PLANNER_SESSIONS`
- R2 bucket → `RIDE_TRIP_PLANNER_ATTACHMENTS`
- OAuth secrets: `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`

Run migrations:
```bash
npm run db:migrate      # applies api/schema.sql
```

Develop against Cloudflare stack:
```bash
npm run dev:remote      # wrangler dev with D1, KV, R2 bindings
```

Static-only preview (no API):
```bash
npm start               # serves public/ at localhost:3000
```

## Deploying

The deploy script auto-bumps the `BUILD_ID` in `api/worker.js` (e.g. `2026-02-15T03` → `2026-02-15T04`) and runs `wrangler deploy`:

```bash
npm run deploy          # node scripts/deploy.js
```

The service worker detects the new build ID within ~2 minutes and silently reloads all open clients. See `DEPLOY.MD` for full Cloudflare setup (D1, KV, R2, OAuth secrets, custom domain).

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/login/:provider` | — | Start OAuth flow |
| GET | `/api/auth/callback/:provider` | — | OAuth callback |
| GET | `/api/auth/me` | ✓ | Current user |
| POST | `/api/auth/logout` | ✓ | End session |
| GET/POST | `/api/trips` | ✓ | List / create trips |
| GET/PUT/DELETE | `/api/trips/:id` | ✓ | Trip CRUD |
| * | `/api/trips/:id/waypoints` | ✓ | Waypoint CRUD |
| * | `/api/trips/:id/journal` | ✓ | Journal CRUD |
| * | `/api/trips/:id/attachments` | ✓ | Attachment CRUD |
| POST | `/api/trips/:id/share` | ✓ | Generate/return share code |
| GET | `/api/s/:code` | — | Public trip data |
| GET | `/api/trips/versions` | ✓ | Lightweight version check |
| GET | `/api/_build` | — | Current build ID |
| GET | `/api/places/search` | ✓ | Nominatim place search |
| POST | `/api/user/purge` | ✓ | Delete all user data |

## License

MIT
