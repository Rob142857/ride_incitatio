/**
 * Ride Trip Planner - Cloudflare Worker API
 * Handles authentication, trip data CRUD, and file attachments
 * Domain: ride.incitat.io
 */

import { Router } from './router.js';
import { AuthHandler } from './auth.js';
import { TripsHandler } from './trips.js';
import { PlacesHandler } from './places.js';
import { cors, jsonResponse, errorResponse, requireAuth, optionalAuth, BASE_URL } from './utils.js';

const router = new Router();

// CORS preflight
router.options('*', () => cors());

// Auth routes
router.get('/api/auth/login/:provider', AuthHandler.initiateLogin);
router.get('/api/auth/callback/:provider', AuthHandler.handleCallback);
router.get('/api/auth/me', requireAuth, AuthHandler.getCurrentUser);
router.post('/api/auth/logout', AuthHandler.logout);
router.get('/api/admin/users', AuthHandler.listUsersAdmin);
router.get('/api/admin/logins', AuthHandler.listLoginsAdmin);

// Trip routes (protected)
router.get('/api/trips', requireAuth, TripsHandler.listTrips);
router.post('/api/trips', requireAuth, TripsHandler.createTrip);
router.get('/api/trips/:id', requireAuth, TripsHandler.getTrip);
router.put('/api/trips/:id', requireAuth, TripsHandler.updateTrip);
router.delete('/api/trips/:id', requireAuth, TripsHandler.deleteTrip);

// Waypoint routes (protected)
router.post('/api/trips/:tripId/waypoints', requireAuth, TripsHandler.addWaypoint);
router.put('/api/trips/:tripId/waypoints/:id', requireAuth, TripsHandler.updateWaypoint);
router.delete('/api/trips/:tripId/waypoints/:id', requireAuth, TripsHandler.deleteWaypoint);
router.put('/api/trips/:tripId/waypoints/reorder', requireAuth, TripsHandler.reorderWaypoints);

// Places search (protected to limit API key exposure)
router.get('/api/places/search', requireAuth, PlacesHandler.search);

// Journal routes (protected)
router.post('/api/trips/:tripId/journal', requireAuth, TripsHandler.addJournalEntry);
router.put('/api/trips/:tripId/journal/:id', requireAuth, TripsHandler.updateJournalEntry);
router.delete('/api/trips/:tripId/journal/:id', requireAuth, TripsHandler.deleteJournalEntry);

// Attachment routes (protected for upload/modify, public for viewing public attachments)
router.post('/api/trips/:tripId/attachments', requireAuth, TripsHandler.uploadAttachment);
router.get('/api/attachments/:id', optionalAuth, TripsHandler.getAttachment);
router.put('/api/attachments/:id', requireAuth, TripsHandler.updateAttachment);
router.delete('/api/attachments/:id', requireAuth, TripsHandler.deleteAttachment);

// Account/data routes
router.post('/api/user/purge', requireAuth, TripsHandler.deleteAllUserData);

// Share routes 
router.post('/api/trips/:id/share', requireAuth, TripsHandler.generateShareLink);

// Short URL public trip API: /api/s/abc123 -> trip JSON data
router.get('/api/s/:shortCode', TripsHandler.getSharedTrip);

// 404 for unmatched API routes
router.all('/api/*', () => errorResponse('Not found', 404));

// Regex for valid 6-char short codes (alphanumeric only)
const SHORT_CODE_REGEX = /^\/([a-zA-Z0-9]{6})$/;

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
        const trip = await env.DB.prepare(
          'SELECT id FROM trips WHERE short_code = ? AND is_public = 1'
        ).bind(shortCode).first();
        
        if (trip) {
          // Valid short code - serve the trip page, passing short code as query param
          const newUrl = new URL('/trip.html', url.origin);
          newUrl.searchParams.set('trip', shortCode);
          return env.ASSETS.fetch(new Request(newUrl, request));
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
    
    // For all other routes, let Pages handle static files
    return env.ASSETS.fetch(request);
  }
};
