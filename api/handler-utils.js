/**
 * Shared handler utilities
 * Common functions used across multiple API handlers
 */

import { jsonResponse } from './utils.js';

/**
 * Safe JSON parse with fallback
 */
export function safeJsonParse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Order waypoints using trip-level settings (persisted waypoint_order)
 */
export function orderWaypointsWithTripSettings(waypointsRows, tripSettings) {
  const waypoints = Array.isArray(waypointsRows) ? waypointsRows : [];
  const settings = safeJsonParse(tripSettings, {});
  const order = Array.isArray(settings?.waypoint_order) ? settings.waypoint_order.map(id => String(id)) : null;

  if (!order || !order.length) return waypoints;

  const byId = new Map(waypoints.map(w => [String(w.id), w]));
  const existingIds = new Set(waypoints.map(w => String(w.id)));
  const unique = new Set(order);

  if (unique.size !== order.length || order.length !== existingIds.size) return waypoints;
  for (const id of unique) {
    if (!existingIds.has(id)) return waypoints;
  }

  return order.map((id, idx) => {
    const w = byId.get(id);
    return { ...w, sort_order: idx };
  });
}

/**
 * Parse If-Match header for optimistic concurrency control
 */
export function parseIfMatchVersion(request) {
  const raw = request?.headers?.get('If-Match');
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^\"|\"$/g, '');
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Return a 409 Conflict response with trip version info
 */
export function conflictResponse(trip) {
  return jsonResponse({
    error: 'Conflict: trip has changed on another device.',
    conflict: true,
    trip_version: trip?.version ?? 0,
    trip_updated_at: trip?.updated_at ?? null
  }, 409);
}

/**
 * Return a 428 Precondition Required response
 */
export function preconditionRequiredResponse() {
  return jsonResponse({
    error: 'Precondition required: missing If-Match header.',
    precondition_required: true
  }, 428);
}

/**
 * Verify trip ownership. Returns the trip row or null.
 * @param {boolean} fullRow - if true, returns SELECT * instead of just id/version/updated_at
 */
export async function verifyTripOwnership(env, tripId, userId, fullRow = false) {
  const cols = fullRow ? '*' : 'id, version, updated_at, settings';
  return env.RIDE_TRIP_PLANNER_DB.prepare(
    `SELECT ${cols} FROM trips WHERE id = ? AND user_id = ?`
  ).bind(tripId, userId).first();
}
