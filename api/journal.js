/**
 * Journal API Handler
 * CRUD operations for trip journal entries
 */

import { jsonResponse, errorResponse, generateId, parseBody } from './utils.js';
import { verifyTripOwnership } from './handler-utils.js';

export const JournalHandler = {
  /**
   * Add journal entry
   */
  async addJournalEntry(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    if (!body?.title) {
      return errorResponse('Title is required');
    }

    const id = generateId();

    await env.RIDE_TRIP_PLANNER_DB.prepare(
      `INSERT INTO journal_entries (id, trip_id, waypoint_id, title, content, is_private, tags, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      params.tripId,
      body.waypoint_id || null,
      body.title,
      body.content || '',
      body.is_private ? 1 : 0,
      JSON.stringify(body.tags || []),
      body.location ? JSON.stringify(body.location) : null
    ).run();

    const entry = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM journal_entries WHERE id = ?').bind(id).first();

    return jsonResponse({
      entry: {
        ...entry,
        tags: JSON.parse(entry.tags || '[]'),
        location: JSON.parse(entry.location || 'null')
      }
    }, 201);
  },

  /**
   * Update journal entry
   */
  async updateJournalEntry(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const updates = [];
    const values = [];

    if (body.title !== undefined) { updates.push('title = ?'); values.push(body.title); }
    if (body.content !== undefined) { updates.push('content = ?'); values.push(body.content); }
    if (body.is_private !== undefined) { updates.push('is_private = ?'); values.push(body.is_private ? 1 : 0); }
    if (body.tags !== undefined) { updates.push('tags = ?'); values.push(JSON.stringify(body.tags)); }
    if (body.location !== undefined) { updates.push('location = ?'); values.push(JSON.stringify(body.location)); }

    if (updates.length > 0) {
      // updated_at auto-managed by trg_journal_updated trigger
      values.push(params.id, params.tripId);
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `UPDATE journal_entries SET ${updates.join(', ')} WHERE id = ? AND trip_id = ?`
      ).bind(...values).run();
    }

    const entry = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM journal_entries WHERE id = ?').bind(params.id).first();

    return jsonResponse({
      entry: {
        ...entry,
        tags: JSON.parse(entry.tags || '[]'),
        location: JSON.parse(entry.location || 'null')
      }
    });
  },

  /**
   * Delete journal entry
   */
  async deleteJournalEntry(context) {
    const { env, user, params } = context;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    await env.RIDE_TRIP_PLANNER_DB.prepare(
      'DELETE FROM journal_entries WHERE id = ? AND trip_id = ?'
    ).bind(params.id, params.tripId).run();

    return jsonResponse({ success: true });
  }
};
