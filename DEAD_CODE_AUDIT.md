# Ride PWA — Dead Code Audit

**Generated:** 2025-01-20  
**Scope:** All files under `public/`, `api/`, `scripts/`  
**Methodology:** Cross-referencing definitions against every `import`, `getElementById`, `querySelector`, function call, and class reference in the codebase.

---

## 1. Dead Files

| File | Lines | Evidence |
|------|-------|----------|
| `public/js/app.js` | 2,198 | Old monolithic `App` object. **NOT** loaded by `index.html`. Only referenced in `sw.js` cache list (line 25) and `README.md` (line 42). All functionality has been refactored into the modular controller files. |
| `public/js/app-old.js` | 2,159 | Even older monolithic `App` copy. Not referenced by any active file whatsoever. |
| `api/trips-old.js` | ~980 | Old trips handler. Never imported by `api/worker.js` or any other active module. |
| `public/view.html` | 792 | README explicitly labels it "Legacy viewer". No active code links to it. `trip.html` serves shared trips (via `api/worker.js` short-code redirect). |

**Stale cache entry:** `public/sw.js` line 25 includes `/js/app.js` in `STATIC_ASSETS`. This caches a dead 2,198-line file on every install.

---

## 2. Dead JavaScript Functions

### `public/js/trip.js` — Trip model

| Method | Line | Reason |
|--------|------|--------|
| `Trip.addWaypoint()` | 81 | Never called by any active controller. App creates waypoints via `API.waypoints.create()` directly. |
| `Trip.createWaypoint()` | 53 | Only called internally by `Trip.addWaypoint()` (dead). |
| `Trip.addJournalEntry()` | 147 | Never called externally. Journal creation goes through `API.journal.create()`. |
| `Trip.createJournalEntry()` | 66 | Only called internally by `Trip.addJournalEntry()` (dead). |
| `Trip.updateJournalEntry()` | 155 | Never called externally. Journal updates go through `API.journal.update()`. |
| `Trip.setCustomRoutePoints()` | 189 | Only invoked in dead `app.js`/`app-old.js`. No reference in modular controllers. |

### `public/js/storage.js` — localStorage abstraction

| Method | Line | Reason |
|--------|------|--------|
| `Storage.getCurrentTripId()` | — | Never called. Trips are now fetched from the API. |
| `Storage.setCurrentTripId()` | — | Never called. |
| `Storage.getTrip()` | — | Never called. |
| `Storage.saveTrip()` | — | Never called. (`saveTrips` only called internally by `clearTrips`.) |
| `Storage.deleteTrip()` | — | Never called. |
| `Storage.getSettings()` | — | Never called. |
| `Storage.saveSettings()` | — | Never called. |
| `Storage.exportAll()` | — | Never called. |
| `Storage.importData()` | — | Never called. |

These are all remnants of the pre-cloud, localStorage-only architecture.

### `public/js/trip-controller.js`

| Method | Line | Reason |
|--------|------|--------|
| `App.generateTripLink()` | 564 | Empty stub (`// Placeholder`). Never called. |
| `App.loadTripDataIfCurrent()` | 131 | Defined but never called from anywhere. |

### `public/js/share.js`

| Method | Line | Reason |
|--------|------|--------|
| `Share.getEmbedUrl()` | 296 | Only called by `Share.getMarkdownLink()` which is itself dead. |
| `Share.getMarkdownLink()` | 306 | Never called externally. |

### `public/js/map.js`

| Method | Line | Reason |
|--------|------|--------|
| `MapManager.haversineLatLng()` | 119 | Defined but never called. The active code uses `App.haversine()` (ride-controller.js) and `MapManager.haversine()` instead. |

---

## 3. Dead / Unused Variables & Properties

| Location | Variable/Property | Issue |
|----------|-------------------|-------|
| `public/js/ui.js` line 79 | `UI.landingGateLastShown` | Set to `true` but never read back anywhere. |
| `public/js/app-core.js` line 242 | `API.shared.get(shareId)` | **Bug:** `API.shared` namespace does not exist in `api.js`. This code path will throw a `TypeError` at runtime. Dead or broken. |

---

## 4. Duplicate Functions

### `formatDistance()` / `formatDuration()` — **3 copies**

| Location | Accessed as |
|----------|-------------|
| `public/js/app-core.js` (via ride-controller.js) | `this.formatDistance()` / `this.formatDuration()` |
| `public/js/ui.js` | `UI.formatDistance()` / `UI.formatDuration()` |
| `public/js/utils.js` | `RideUtils.formatDistance()` / `RideUtils.formatDuration()` |

All three are nearly identical. `ride-controller.js` calls both `this.formatDistance()` (App method) and `RideUtils.formatDistance()` (utils.js). Should consolidate into one canonical copy.

### `haversine()` — **2 copies**

| Location | Accessed as |
|----------|-------------|
| `public/js/ride-controller.js` | `App.haversine(lat1, lng1, lat2, lng2)` |
| `public/js/map.js` | `MapManager.haversine(lat1, lng1, lat2, lng2)` |

Both are identical Haversine implementations.

### Entire `App` object — **3 copies**

| File | Status |
|------|--------|
| `public/js/app-core.js` + controllers | **Active** (modular) |
| `public/js/app.js` | **Dead** (monolithic) |
| `public/js/app-old.js` | **Dead** (older monolithic) |

---

## 5. Dead CSS Selectors

### `public/css/app.css` — Top of file (lines 1–30)

These selectors were likely from an earlier share UI iteration:

| Selector | Line | Evidence |
|----------|------|----------|
| `.trip-public-toggle` | 2 | Not used in any HTML or JS file. |
| `.share-public-toggle` | 2 | Not used in any HTML or JS file. |
| `.public-toggle-checkbox` | 13 | Not used in any HTML or JS file. |
| `.share-checkbox-group` | 19 | Not used in any HTML or JS file. |
| `.share-checkbox-label` | 25 | Not used in any HTML or JS file. |

### Other dead selectors/rules

| Selector / Rule | Line | Evidence |
|----------------|------|----------|
| `.doc-section` | 347 | Class defined in CSS only; not used in any HTML file. |
| `.doc-callout` | 351 | Class defined in CSS only; not used in any HTML file. |
| `.sortable-ghost` | 2704 | Class defined in CSS only; not in any HTML or JS file. |
| `.drag-handle` | 2708 | Class defined in CSS only; not in any HTML or JS file. (Waypoints use `.waypoint-handle` instead.) |
| `@keyframes modalFadeIn` | 1609 | Keyframes rule defined but never referenced by any `animation` property. (`modalSlideIn` is used instead.) |

---

## 6. Unreferenced HTML Elements

| Element | File | Issue |
|---------|------|-------|
| `<span id="rideTripName">` | `index.html` line 170 | Has class `hidden`, is set via JS — but the ride overlay banner no longer displays this element visually. The JS writes to it (`ride-controller.js` line 48) but it remains hidden. Likely vestigial. |

---

## 7. API Backend — Minor Issues

| Item | Location | Issue |
|------|----------|-------|
| `generateShortCode()` export | `api/utils.js` line 81 | Exported but only imported by dead `api/trips-old.js`. Active code only uses `generateShortCodeForId()` (which calls `generateShortCode` internally). The export itself is harmless but unnecessary. |
| `preconditionRequiredResponse()` | `api/handler-utils.js` line 73 | Used in active code (`waypoints.js`). However, `api/trips-old.js` has its own local duplicate (line 66). The duplicate is dead with the file. |

---

## Summary of Savings

| Category | Items | Estimated dead lines |
|----------|-------|---------------------|
| Dead files | 4 files | **~5,330 lines** (app.js 2198 + app-old.js 2159 + trips-old.js ~980 + view.html 792) |
| Dead JS functions | 15 methods | ~200 lines |
| Dead CSS selectors | 10 rules + 1 keyframes | ~60 lines |
| Duplicated functions | 5 duplicates across files | ~80 lines (after consolidation) |
| **Total removable** | | **~5,670 lines** |

---

## Recommended Actions

1. **Delete** `public/js/app.js`, `public/js/app-old.js`, `api/trips-old.js`, and `public/view.html`.
2. **Remove** `/js/app.js` from the `STATIC_ASSETS` array in `public/sw.js` line 25.
3. **Fix or remove** the `API.shared.get()` call in `app-core.js` line 242 — it will crash at runtime.
4. **Prune** dead methods from `trip.js` and `storage.js`.
5. **Consolidate** `formatDistance`/`formatDuration`/`haversine` into a single canonical location (e.g., `utils.js`).
6. **Delete** dead CSS at the top of `app.css` (lines 1–30) and the orphaned `.sortable-ghost`, `.drag-handle`, `.doc-section`, `.doc-callout`, `@keyframes modalFadeIn` rules.
