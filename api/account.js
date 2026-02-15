/**
 * Account API Handler
 * User data management (purge all data)
 */

import { jsonResponse } from './utils.js';

export const AccountHandler = {
  /**
   * Delete all user-owned trips and related data.
   * Cleans up R2 attachment binaries before wiping DB rows.
   */
  async deleteAllUserData(context) {
    const { env, user } = context;

    // Collect attachment storage keys
    const attachments = await env.RIDE_TRIP_PLANNER_DB.prepare(
      'SELECT a.storage_key FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE t.user_id = ?'
    ).bind(user.id).all();

    // Best-effort R2 cleanup
    for (const row of attachments.results || []) {
      try {
        await env.RIDE_TRIP_PLANNER_ATTACHMENTS.delete(row.storage_key);
      } catch (err) {
        console.error('R2 delete failed', row.storage_key, err);
      }
    }

    // Remove all trips (cascades to child tables via FK)
    await env.RIDE_TRIP_PLANNER_DB.prepare('DELETE FROM trips WHERE user_id = ?').bind(user.id).run();

    return jsonResponse({ success: true, deleted_objects: attachments.results?.length || 0 });
  }
};
