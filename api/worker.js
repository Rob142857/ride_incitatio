/**
 * Ride Trip Planner - Cloudflare Worker API
 * Handles authentication, trip data CRUD, and file attachments
 * Domain: ride.incitat.io
 */

import { Router } from './router.js';
import { AuthHandler } from './auth.js';
import { TripsHandler } from './trips.js';
import { WaypointsHandler } from './waypoints.js';
import { JournalHandler } from './journal.js';
import { AttachmentsHandler } from './attachments.js';
import { ShareHandler } from './share.js';
import { AccountHandler } from './account.js';
import { PlacesHandler } from './places.js';
import { cors, jsonResponse, errorResponse, requireAuth, requireAdmin, optionalAuth, BASE_URL } from './utils.js';

// Build fingerprint — changes on every deploy. Used by service worker and client
// to detect code updates and trigger cache invalidation + seamless reload.
// Updated automatically by deploy script, or manually before shipping.
const BUILD_ID = '2026-02-15T09';

const router = new Router();

// CORS preflight
router.options('*', () => cors());

// Auth routes
router.get('/api/auth/login/:provider', AuthHandler.initiateLogin);
router.get('/api/auth/callback/:provider', AuthHandler.handleCallback);
router.get('/api/auth/me', requireAuth, AuthHandler.getCurrentUser);
router.post('/api/auth/logout', AuthHandler.logout);
router.get('/api/admin/users', requireAdmin, AuthHandler.listUsersAdmin);
router.get('/api/admin/logins', requireAdmin, AuthHandler.listLoginsAdmin);

// Trip routes (protected)
router.get('/api/trips', requireAuth, TripsHandler.listTrips);
router.post('/api/trips', requireAuth, TripsHandler.createTrip);
router.get('/api/trips/:id', requireAuth, TripsHandler.getTrip);
router.put('/api/trips/:id', requireAuth, TripsHandler.updateTrip);
router.delete('/api/trips/:id', requireAuth, TripsHandler.deleteTrip);

// Waypoint routes (protected)
router.post('/api/trips/:tripId/waypoints', requireAuth, WaypointsHandler.addWaypoint);
router.put('/api/trips/:tripId/waypoints/:id', requireAuth, WaypointsHandler.updateWaypoint);
router.delete('/api/trips/:tripId/waypoints/:id', requireAuth, WaypointsHandler.deleteWaypoint);
router.put('/api/trips/:tripId/waypoints/reorder', requireAuth, WaypointsHandler.reorderWaypoints);

// Places search (protected to limit API key exposure)
router.get('/api/places/search', requireAuth, PlacesHandler.search);

// Journal routes (protected)
router.post('/api/trips/:tripId/journal', requireAuth, JournalHandler.addJournalEntry);
router.put('/api/trips/:tripId/journal/:id', requireAuth, JournalHandler.updateJournalEntry);
router.delete('/api/trips/:tripId/journal/:id', requireAuth, JournalHandler.deleteJournalEntry);

// Attachment routes (protected for upload/modify, public for viewing public attachments)
router.post('/api/trips/:tripId/attachments', requireAuth, AttachmentsHandler.uploadAttachment);
router.get('/api/attachments/:id', optionalAuth, AttachmentsHandler.getAttachment);
router.put('/api/attachments/:id', requireAuth, AttachmentsHandler.updateAttachment);
router.delete('/api/attachments/:id', requireAuth, AttachmentsHandler.deleteAttachment);

// Account/data routes
router.post('/api/user/purge', requireAuth, AccountHandler.deleteAllUserData);

// Share routes 
router.post('/api/trips/:id/share', requireAuth, ShareHandler.generateShareLink);

// Short URL public trip API: /api/s/abc123 -> trip JSON data
router.get('/api/s/:shortCode', ShareHandler.getSharedTrip);

// Deploy sanity-check endpoint (no auth)
// Bump DEPLOY_MARKER when you want to verify a new deploy via curl.
router.get('/api/_deploy', () => {
  const DEPLOY_MARKER = 'deploy-marker:2025-12-27T00:00Z:waypoint-precondition-v1';
  return jsonResponse({ ok: true, marker: DEPLOY_MARKER, now: new Date().toISOString() });
});

// Build version endpoint — lightweight, no auth
// Clients and service workers poll this to detect code updates.
router.get('/api/_build', () => {
  return new Response(JSON.stringify({ build: BUILD_ID }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// Trip version check — returns just id+version for the current user's trips.
// Used by the client to poll for stale data without fetching full trip payloads.
router.get('/api/trips/versions', requireAuth, async (context) => {
  const { env, user } = context;
  const rows = await env.RIDE_TRIP_PLANNER_DB.prepare(
    'SELECT id, version, updated_at FROM trips WHERE user_id = ?'
  ).bind(user.id).all();
  return jsonResponse({ trips: rows.results });
});

// 404 for unmatched API routes
router.all('/api/*', () => errorResponse('Not found', 404));

// Regex for valid 6-char short codes (alphanumeric only)
const SHORT_CODE_REGEX = /^\/([a-zA-Z0-9]{6})$/;

// Content Security Policy for HTML responses
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com https://server.arcgisonline.com https://ride.incitat.io https://lh3.googleusercontent.com https://*.microsoft.com",
  "connect-src 'self' https://ride.incitat.io https://maps.incitat.io https://router.project-osrm.org https://nominatim.openstreetmap.org",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com https://login.microsoftonline.com"
].join('; ');

/**
 * Add security headers to HTML responses
 */
function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  // Build fingerprint lets clients detect code updates
  headers.set('X-Build-ID', BUILD_ID);
  headers.set('ETag', `"${BUILD_ID}"`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle API routes first
    if (url.pathname.startsWith('/api/')) {
      try {
        return await router.handle(request, env, ctx);
      } catch (error) {
        console.error('Worker error:', error);
        return errorResponse('Internal server error', 500);
      }
    }
    
    // Check for root-level short code: ride.incitat.io/abc123
    // Must be exactly 6 alphanumeric characters, no extension
    const shortCodeMatch = url.pathname.match(SHORT_CODE_REGEX);
    if (shortCodeMatch) {
      const shortCode = shortCodeMatch[1];
      
      // Verify this short code exists in DB before serving the page
      // This prevents serving trip.html for random 6-char paths
      try {
        const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
          'SELECT id FROM trips WHERE short_code = ? AND is_public = 1'
        ).bind(shortCode).first();
        
        if (trip) {
          // Valid short code - serve the trip page, passing short code as query param
          const newUrl = new URL('/trip.html', url.origin);
          newUrl.searchParams.set('trip', shortCode);
          const resp = await env.ASSETS.fetch(new Request(newUrl, request));
          return addSecurityHeaders(resp);
        }
      } catch (error) {
        console.error('Short code lookup error:', error);
      }
      
      // Invalid short code - fall through to 404 or static assets
    }
    
    // Legacy support: /t/abc123 redirects to /abc123
    if (url.pathname.match(/^\/t\/[a-zA-Z0-9]{6}$/)) {
      const shortCode = url.pathname.split('/')[2];
      return Response.redirect(`${BASE_URL}/${shortCode}`, 301);
    }
    
    // Legacy support: /trip/abc123 redirects to /abc123
    if (url.pathname.match(/^\/trip\/[a-zA-Z0-9]{6}$/)) {
      const shortCode = url.pathname.split('/')[2];
      return Response.redirect(`${BASE_URL}/${shortCode}`, 301);
    }
    
    // For all other routes, let Pages handle static files (add security headers to HTML)
    const response = await env.ASSETS.fetch(request);
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      return addSecurityHeaders(response);
    }
    return response;
  }
};
