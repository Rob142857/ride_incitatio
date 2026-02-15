/**
 * Trips API Handler
 * Core CRUD operations for trips (trip-level only)
 */

import { jsonResponse, errorResponse, generateId, generateShortCodeForId, parseBody, BASE_URL } from './utils.js';
import { safeJsonParse, orderWaypointsWithTripSettings, parseIfMatchVersion, conflictResponse } from './handler-utils.js';

export const TripsHandler = {
  /**
   * List all trips for current user
   */
  async listTrips(context) {
    const { env, user } = context;

    const trips = await env.RIDE_TRIP_PLANNER_DB.prepare(
      `SELECT t.*, 
        (SELECT COUNT(*) FROM waypoints WHERE trip_id = t.id) as waypoint_count,
        (SELECT COUNT(*) FROM journal_entries WHERE trip_id = t.id) as journal_count,
        (SELECT COUNT(*) FROM attachments WHERE trip_id = t.id) as attachment_count
       FROM trips t 
       WHERE t.user_id = ? 
       ORDER BY t.updated_at DESC`
    ).bind(user.id).all();

    const results = (trips.results || []).map(t => ({
      ...t,
      short_url: t.short_code ? `${BASE_URL}/${t.short_code}` : null
    }));

    return jsonResponse({ trips: results });
  },

  /**
   * Create a new trip with collision-proof short code
   */
  async createTrip(context) {
    const { env, user, request } = context;
    const body = await parseBody(request);

    if (!body?.name) {
      return errorResponse('Trip name is required');
    }

    const id = generateId();
    const settings = JSON.stringify(body.settings || {});

    let shortCode = generateShortCodeForId(id);
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        await env.RIDE_TRIP_PLANNER_DB.prepare(
          `INSERT INTO trips (id, user_id, name, description, settings, short_code) 
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(id, user.id, body.name, body.description || '', settings, shortCode).run();
        break;
      } catch (error) {
        if (error.message?.includes('UNIQUE constraint') && attempts < maxAttempts - 1) {
          attempts++;
          shortCode = generateShortCodeForId(`${id}:${attempts}`);
          continue;
        }
        throw error;
      }
    }

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first();
    trip.short_url = `${BASE_URL}/${shortCode}`;

    return jsonResponse({ trip }, 201);
  },

  /**
   * Get a single trip with all data
   */
  async getTrip(context) {
    const { env, user, params } = context;

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();

    if (!trip) return errorResponse('Trip not found', 404);

    const waypoints = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM waypoints WHERE trip_id = ? ORDER BY sort_order'
    ).bind(params.id).all();

    const orderedWaypoints = orderWaypointsWithTripSettings(waypoints.results, trip.settings);

    const journal = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM journal_entries WHERE trip_id = ? ORDER BY created_at DESC'
    ).bind(params.id).all();

    const attachments = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM attachments WHERE trip_id = ? ORDER BY created_at DESC'
    ).bind(params.id).all();

    const routeData = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT * FROM route_data WHERE trip_id = ?'
    ).bind(params.id).first();

    const attachmentsWithUrls = attachments.results.map(a => ({
      ...a,
      url: `${BASE_URL}/api/attachments/${a.id}`
    }));

    return jsonResponse({
      trip: {
        ...trip,
        settings: safeJsonParse(trip.settings || '{}', {}),
        short_url: trip.short_code ? `${BASE_URL}/${trip.short_code}` : null,
        waypoints: orderedWaypoints,
        journal: journal.results.map(e => ({
          ...e,
          tags: JSON.parse(e.tags || '[]'),
          location: JSON.parse(e.location || 'null')
        })),
        attachments: attachmentsWithUrls,
        route: routeData ? {
          coordinates: JSON.parse(routeData.coordinates || '[]'),
          distance: routeData.distance,
          duration: routeData.duration
        } : null
      }
    });
  },

  /**
   * Update a trip
   */
  async updateTrip(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);

    const existing = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id, version, updated_at, settings FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();

    if (!existing) return errorResponse('Trip not found', 404);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch !== null && Number(existing.version ?? 0) !== ifMatch) {
      return conflictResponse(existing);
    }

    const updates = [];
    const values = [];

    if (body.name !== undefined) { updates.push('name = ?'); values.push(body.name); }
    if (body.description !== undefined) { updates.push('description = ?'); values.push(body.description); }
    if (body.settings !== undefined) {
      const existingSettings = safeJsonParse(existing.settings || '{}', {});
      let mergedSettings = body.settings;
      if (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) {
        mergedSettings = { ...existingSettings, ...body.settings };
        if (Object.prototype.hasOwnProperty.call(body.settings, 'waypoint_order') && body.settings.waypoint_order === null) {
          delete mergedSettings.waypoint_order;
        }
      }
      updates.push('settings = ?');
      values.push(JSON.stringify(mergedSettings));
    }
    if (body.is_public !== undefined) { updates.push('is_public = ?'); values.push(body.is_public ? 1 : 0); }
    if (body.public_title !== undefined) { updates.push('public_title = ?'); values.push(body.public_title); }
    if (body.public_description !== undefined) { updates.push('public_description = ?'); values.push(body.public_description); }
    if (body.public_contact !== undefined) { updates.push('public_contact = ?'); values.push(body.public_contact); }
    if (body.cover_image_url !== undefined) { updates.push('cover_image_url = ?'); values.push(body.cover_image_url); }
    if (body.cover_focus_x !== undefined) { updates.push('cover_focus_x = ?'); values.push(body.cover_focus_x); }
    if (body.cover_focus_y !== undefined) { updates.push('cover_focus_y = ?'); values.push(body.cover_focus_y); }

    if (updates.length > 0) {
      values.push(params.id);
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `UPDATE trips SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...values).run();
    }

    // Update route data if provided (triggers auto-bump trip version)
    if (body.route) {
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `INSERT OR REPLACE INTO route_data (id, trip_id, coordinates, distance, duration)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        generateId(), params.id,
        JSON.stringify(body.route.coordinates || []),
        body.route.distance || null,
        body.route.duration || null
      ).run();
    }

    const trip = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM trips WHERE id = ?').bind(params.id).first();
    return jsonResponse({ trip });
  },

  /**
   * Delete a trip
   */
  async deleteTrip(context) {
    const { env, user, params } = context;

    const result = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).run();

    if (result.meta.changes === 0) {
      return errorResponse('Trip not found', 404);
    }

    return jsonResponse({ success: true });
  }
};
