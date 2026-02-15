/**
 * Attachments API Handler
 * Upload, retrieve, update, and delete trip attachments (R2)
 */

import { jsonResponse, errorResponse, generateId, parseBody, BASE_URL } from './utils.js';
import { verifyTripOwnership } from './handler-utils.js';

export const AttachmentsHandler = {
  /**
   * Upload attachment to trip
   */
  async uploadAttachment(context) {
    const { env, user, params, request } = context;

    const trip = await verifyTripOwnership(env, params.tripId, user.id);
    if (!trip) return errorResponse('Trip not found', 404);

    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) return errorResponse('No file provided');

    const id = generateId();
    const ext = file.name.split('.').pop() || 'bin';
    const storageKey = `trips/${params.tripId}/${id}.${ext}`;

    const isPrivate = formData.get('is_private') === 'true' || formData.get('is_private') === '1';
    const isCover = formData.get('is_cover') === 'true' || formData.get('is_cover') === '1';
    const caption = formData.get('caption') || '';
    const journalEntryId = formData.get('journal_entry_id') || null;
    const waypointId = formData.get('waypoint_id') || null;

    // Upload to R2 then insert DB; cleanup R2 on DB failure
    // Note: scope validation (journal/waypoint belong to trip) and cover image
    // management (unsetting other covers) are enforced by v2 schema triggers.
    let objectPutSucceeded = false;
    try {
      await env.RIDE_TRIP_PLANNER_ATTACHMENTS.put(storageKey, file.stream(), {
        httpMetadata: { contentType: file.type },
        customMetadata: { originalName: file.name, tripId: params.tripId }
      });
      objectPutSucceeded = true;

      // Cover image management handled by v2 schema triggers
      await env.RIDE_TRIP_PLANNER_DB.prepare(
        `INSERT INTO attachments (id, trip_id, journal_entry_id, waypoint_id, filename, original_name, mime_type, size_bytes, storage_key, is_private, is_cover, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, params.tripId, journalEntryId, waypointId,
        `${id}.${ext}`, file.name, file.type, file.size,
        storageKey, isPrivate ? 1 : 0, isCover ? 1 : 0, caption
      ).run();

      const attachment = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first();

      return jsonResponse({
        attachment: { ...attachment, url: `${BASE_URL}/api/attachments/${id}` }
      }, 201);
    } catch (err) {
      if (objectPutSucceeded) {
        try { await env.RIDE_TRIP_PLANNER_ATTACHMENTS.delete(storageKey); } catch (_) {}
      }
      throw err;
    }
  },

  /**
   * Get attachment file (supports public access for public attachments)
   */
  async getAttachment(context) {
    const { env, params, user } = context;

    const attachment = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT a.*, t.user_id, t.is_public as trip_is_public FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE a.id = ?'
    ).bind(params.id).first();

    if (!attachment) return errorResponse('Attachment not found', 404);

    const isOwner = user && user.id === attachment.user_id;
    const isPubliclyAccessible = attachment.trip_is_public && !attachment.is_private;

    if (!isOwner && !isPubliclyAccessible) {
      return errorResponse('Attachment not found', 404);
    }

    const object = await env.RIDE_TRIP_PLANNER_ATTACHMENTS.get(attachment.storage_key);
    if (!object) return errorResponse('File not found', 404);

    const headers = new Headers();
    headers.set('Content-Type', attachment.mime_type);
    headers.set('Content-Length', attachment.size_bytes);
    headers.set('Cache-Control', 'public, max-age=31536000');

    if (attachment.mime_type.startsWith('image/')) {
      headers.set('Content-Disposition', `inline; filename="${attachment.original_name}"`);
    } else {
      headers.set('Content-Disposition', `attachment; filename="${attachment.original_name}"`);
    }

    return new Response(object.body, { headers });
  },

  /**
   * Update attachment metadata
   */
  async updateAttachment(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);

    const attachment = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT a.*, t.user_id FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE a.id = ?'
    ).bind(params.id).first();

    if (!attachment || attachment.user_id !== user.id) {
      return errorResponse('Attachment not found', 404);
    }

    const updates = [];
    const values = [];

    if (body.caption !== undefined) { updates.push('caption = ?'); values.push(body.caption); }
    if (body.is_private !== undefined) { updates.push('is_private = ?'); values.push(body.is_private ? 1 : 0); }
    if (body.is_cover !== undefined) {
      // Cover image management (unsetting others) handled by v2 schema triggers
      updates.push('is_cover = ?');
      values.push(body.is_cover ? 1 : 0);
    }

    if (updates.length > 0) {
      values.push(params.id);
      await env.RIDE_TRIP_PLANNER_DB.prepare(`UPDATE attachments SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    }

    const updated = await env.RIDE_TRIP_PLANNER_DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(params.id).first();
    return jsonResponse({
      attachment: { ...updated, url: `${BASE_URL}/api/attachments/${params.id}` }
    });
  },

  /**
   * Delete attachment
   */
  async deleteAttachment(context) {
    const { env, user, params } = context;

    const attachment = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT a.*, t.user_id FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE a.id = ?'
    ).bind(params.id).first();

    if (!attachment || attachment.user_id !== user.id) {
      return errorResponse('Attachment not found', 404);
    }

    // Delete from R2 then DB
    await env.RIDE_TRIP_PLANNER_ATTACHMENTS.delete(attachment.storage_key);
    await env.RIDE_TRIP_PLANNER_DB.prepare('DELETE FROM attachments WHERE id = ?').bind(params.id).run();

    return jsonResponse({ success: true });
  }
};
