/**
 * Waypoints API Handler
 * CRUD + reorder operations for trip waypoints
 */

import { jsonResponse, errorResponse, generateId, parseBody } from './utils.js';
import { verifyTripOwnership, parseIfMatchVersion, conflictResponse, preconditionRequiredResponse, safeJsonParse } from './handler-utils.js';

export const WaypointsHandler = {
  /**
   * Add waypoint to trip
   */
  async addWaypoint(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();
    if (Number(trip.version ?? 0) !== ifMatch) return conflictResponse(trip);

    if (!body?.name || body.lat === undefined || body.lng === undefined) {
      return errorResponse('Name, lat, and lng are required');
    }

    const lastWp = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT MAX(sort_order) as max_order FROM waypoints WHERE trip_id = ?'
    ).bind(params.tripId).first();

    const sortOrder = (lastWp?.max_order ?? -1) + 1;
    const id = generateId();

    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'INSERT INTO waypoints (id, trip_id, name, address, lat, lng, type, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, params.tripId, body.name, body.address || '', body.lat, body.lng, body.type || 'stop', body.notes || '', sortOrder).run();

    const waypoint = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM waypoints WHERE id = ?').bind(id).first();
    const tripState = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT version, updated_at FROM trips WHERE id = ?').bind(params.tripId).first();

    return jsonResponse({ waypoint, trip_version: tripState?.version ?? 0, trip_updated_at: tripState?.updated_at ?? null }, 201);
  },

  /**
   * Update waypoint
   */
  async updateWaypoint(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();
    if (Number(trip.version ?? 0) !== ifMatch) return conflictResponse(trip);

    const updates = [];
    const values = [];

    ['name', 'address', 'lat', 'lng', 'type', 'notes', 'sort_order'].forEach(field => {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    });

    if (updates.length > 0) {
      values.push(params.id, params.tripId);
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `UPDATE waypoints SET ${updates.join(', ')} WHERE id = ? AND trip_id = ?`
      ).bind(...values).run();
    }

    const waypoint = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM waypoints WHERE id = ?').bind(params.id).first();
    const tripState = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT version, updated_at FROM trips WHERE id = ?').bind(params.tripId).first();

    return jsonResponse({ waypoint, trip_version: tripState?.version ?? 0, trip_updated_at: tripState?.updated_at ?? null });
  },

  /**
   * Delete waypoint
   */
  async deleteWaypoint(context) {
    const { env, user, params, request } = context;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();
    if (Number(trip.version ?? 0) !== ifMatch) return conflictResponse(trip);

    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM waypoints WHERE id = ? AND trip_id = ?'
    ).bind(params.id, params.tripId).run();

    const tripState = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT version, updated_at FROM trips WHERE id = ?').bind(params.tripId).first();
    return jsonResponse({ success: true, trip_version: tripState?.version ?? 0, trip_updated_at: tripState?.updated_at ?? null });
  },

  /**
   * Reorder waypoints (batched in D1 transaction)
   */
  async reorderWaypoints(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);

    if (!body?.order || !Array.isArray(body.order)) {
      return errorResponse('Order array is required');
    }

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const ifMatch = parseIfMatchVersion(request);
    if (ifMatch === null) return preconditionRequiredResponse();
    if (Number(trip.version ?? 0) !== ifMatch) return conflictResponse(trip);

    // Validate order contains every waypoint exactly once
    const existingWps = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT id FROM waypoints WHERE trip_id = ?'
    ).bind(params.tripId).all();

    const existingIds = (existingWps.results || []).map(r => r.id);
    const desired = body.order.map(id => String(id));
    const uniqueDesired = new Set(desired);

    if (desired.length !== existingIds.length || uniqueDesired.size !== desired.length) {
      return errorResponse('Order must include each waypoint exactly once', 400);
    }

    const existingSet = new Set(existingIds);
    for (const id of uniqueDesired) {
      if (!existingSet.has(id)) {
        return errorResponse('Order contains invalid waypoint id', 400);
      }
    }

    // Batch all reorder updates in a single D1 transaction
    const stmts = desired.map((id, i) =>
      env.RIDE_TRIP_PLANNER_DB.prepare(
        'UPDATE waypoints SET sort_order = ? WHERE id = ? AND trip_id = ?'
      ).bind(i, id, params.tripId)
    );

    // Also persist ordering on the trip settings
    const settings = safeJsonParse(trip.settings || '{}', {});
    settings.waypoint_order = desired;
    stmts.push(
      env.RIDE_TRIP_PLANNER_DB.prepare(
        'UPDATE trips SET settings = ? WHERE id = ?'
      ).bind(JSON.stringify(settings), params.tripId)
    );

    await env.RIDE_TRIP_PLANNER_DB.batch(stmts);

    const tripState = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT version, updated_at FROM trips WHERE id = ?').bind(params.tripId).first();
    return jsonResponse({ success: true, trip_version: tripState?.version ?? 0, trip_updated_at: tripState?.updated_at ?? null });
  }
};
