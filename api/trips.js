/**
 * Trips API Handler
 * CRUD operations for trips, waypoints, journal entries, and attachments
 */

import { jsonResponse, errorResponse, generateId, generateShortCode, generateShortCodeForId, parseBody, BASE_URL } from './utils.js';

export const TripsHandler = {
  /**
   * List all trips for current user
   */
  async listTrips(context) {
    const { env, user } = context;
    
    const trips = await env.DB.prepare(
      `SELECT t.*, 
        (SELECT COUNT(*) FROM waypoints WHERE trip_id = t.id) as waypoint_count,
        (SELECT COUNT(*) FROM journal_entries WHERE trip_id = t.id) as journal_count,
        (SELECT COUNT(*) FROM attachments WHERE trip_id = t.id) as attachment_count
       FROM trips t 
       WHERE t.user_id = ? 
       ORDER BY t.updated_at DESC`
    ).bind(user.id).all();
    
    const results = (trips.results || []).map((t) => ({
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
    
    // Generate deterministic short code from trip ID, with rare collision retries
    let shortCode = generateShortCodeForId(id);
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        await env.DB.prepare(
          `INSERT INTO trips (id, user_id, name, description, settings, short_code) 
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(id, user.id, body.name, body.description || '', settings, shortCode).run();
        break; // Success
      } catch (error) {
        if (error.message?.includes('UNIQUE constraint') && attempts < maxAttempts - 1) {
          attempts++;
          shortCode = generateShortCodeForId(`${id}:${attempts}`);
          continue; // Retry with deterministic variant
        }
        throw error; // Re-throw if not a collision or max attempts reached
      }
    }
    
    const trip = await env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first();
    trip.short_url = `${BASE_URL}/${shortCode}`;
    
    return jsonResponse({ trip }, 201);
  },
  
  /**
   * Get a single trip with all data
   */
  async getTrip(context) {
    const { env, user, params } = context;
    
    const trip = await env.DB.prepare(
      'SELECT * FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();
    
    if (!trip) {
      return errorResponse('Trip not found', 404);
    }
    
    // Get waypoints
    const waypoints = await env.DB.prepare(
      'SELECT * FROM waypoints WHERE trip_id = ? ORDER BY sort_order'
    ).bind(params.id).all();
    
    // Get journal entries (all - owner can see private)
    const journal = await env.DB.prepare(
      'SELECT * FROM journal_entries WHERE trip_id = ? ORDER BY created_at DESC'
    ).bind(params.id).all();
    
    // Get attachments (all - owner can see private)
    const attachments = await env.DB.prepare(
      'SELECT * FROM attachments WHERE trip_id = ? ORDER BY created_at DESC'
    ).bind(params.id).all();
    
    // Get route data
    const routeData = await env.DB.prepare(
      'SELECT * FROM route_data WHERE trip_id = ?'
    ).bind(params.id).first();
    
    // Generate attachment URLs
    const attachmentsWithUrls = attachments.results.map(a => ({
      ...a,
      url: `${BASE_URL}/api/attachments/${a.id}`
    }));
    
    return jsonResponse({
      trip: {
        ...trip,
        settings: JSON.parse(trip.settings || '{}'),
        short_url: trip.short_code ? `${BASE_URL}/${trip.short_code}` : null,
        waypoints: waypoints.results,
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
    
    // Verify ownership
    const existing = await env.DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();
    
    if (!existing) {
      return errorResponse('Trip not found', 404);
    }
    
    const updates = [];
    const values = [];
    
    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description);
    }
    if (body.settings !== undefined) {
      updates.push('settings = ?');
      values.push(JSON.stringify(body.settings));
    }
    if (body.is_public !== undefined) {
      updates.push('is_public = ?');
      values.push(body.is_public ? 1 : 0);
    }
    // Public display settings (no personal info shown)
    if (body.public_title !== undefined) {
      updates.push('public_title = ?');
      values.push(body.public_title);
    }
    if (body.public_description !== undefined) {
      updates.push('public_description = ?');
      values.push(body.public_description);
    }
    if (body.public_contact !== undefined) {
      updates.push('public_contact = ?');
      values.push(body.public_contact);
    }
    if (body.cover_image_url !== undefined) {
      updates.push('cover_image_url = ?');
      values.push(body.cover_image_url);
    }
    
    if (updates.length > 0) {
      updates.push('updated_at = datetime("now")');
      values.push(params.id);
      
      await env.DB.prepare(
        `UPDATE trips SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...values).run();
    }
    
    // Update route data if provided
    if (body.route) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO route_data (id, trip_id, coordinates, distance, duration, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime("now"))`
      ).bind(
        generateId(),
        params.id,
        JSON.stringify(body.route.coordinates || []),
        body.route.distance || null,
        body.route.duration || null
      ).run();
    }
    
    const trip = await env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(params.id).first();
    
    return jsonResponse({ trip });
  },
  
  /**
   * Delete a trip
   */
  async deleteTrip(context) {
    const { env, user, params } = context;
    
    const result = await env.DB.prepare(
      'DELETE FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).run();
    
    if (result.meta.changes === 0) {
      return errorResponse('Trip not found', 404);
    }
    
    return jsonResponse({ success: true });
  },
  
  /**
   * Add waypoint to trip
   */
  async addWaypoint(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    
    // Verify trip ownership
    const trip = await env.DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    
    if (!trip) {
      return errorResponse('Trip not found', 404);
    }
    
    if (!body?.name || body.lat === undefined || body.lng === undefined) {
      return errorResponse('Name, lat, and lng are required');
    }
    
    // Get next sort order
    const lastWp = await env.DB.prepare(
      'SELECT MAX(sort_order) as max_order FROM waypoints WHERE trip_id = ?'
    ).bind(params.tripId).first();
    
    const sortOrder = (lastWp?.max_order ?? -1) + 1;
    const id = generateId();
    
    await env.DB.prepare(
      'INSERT INTO waypoints (id, trip_id, name, address, lat, lng, type, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, params.tripId, body.name, body.address || '', body.lat, body.lng, body.type || 'stop', body.notes || '', sortOrder).run();
    
    // Update trip timestamp
    await env.DB.prepare('UPDATE trips SET updated_at = datetime("now") WHERE id = ?').bind(params.tripId).run();
    
    const waypoint = await env.DB.prepare('SELECT * FROM waypoints WHERE id = ?').bind(id).first();
    
    return jsonResponse({ waypoint }, 201);
  },
  
  /**
   * Update waypoint
   */
  async updateWaypoint(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    
    // Verify trip ownership
    const trip = await env.DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    
    if (!trip) {
      return errorResponse('Trip not found', 404);
    }
    
    const updates = [];
    const values = [];
    
    ['name', 'address', 'lat', 'lng', 'type', 'notes', 'sort_order'].forEach(field => {
      if (body[field] !== undefined) {
        updates.push(`${field === 'sort_order' ? 'sort_order' : field} = ?`);
        values.push(body[field]);
      }
    });
    
    if (updates.length > 0) {
      values.push(params.id, params.tripId);
      await env.DB.prepare(
        `UPDATE waypoints SET ${updates.join(', ')} WHERE id = ? AND trip_id = ?`
      ).bind(...values).run();
      
      await env.DB.prepare('UPDATE trips SET updated_at = datetime("now") WHERE id = ?').bind(params.tripId).run();
    }
    
    const waypoint = await env.DB.prepare('SELECT * FROM waypoints WHERE id = ?').bind(params.id).first();
    
    return jsonResponse({ waypoint });
  },
  
  /**
   * Delete waypoint
   */
  async deleteWaypoint(context) {
    const { env, user, params } = context;
    
    // Verify trip ownership
    const trip = await env.DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    
    if (!trip) {
      return errorResponse('Trip not found', 404);
    }
    
    await env.DB.prepare(
      'DELETE FROM waypoints WHERE id = ? AND trip_id = ?'
    ).bind(params.id, params.tripId).run();
    
    await env.DB.prepare('UPDATE trips SET updated_at = datetime("now") WHERE id = ?').bind(params.tripId).run();
    
    return jsonResponse({ success: true });
  },
  
  /**
   * Reorder waypoints
   */
  async reorderWaypoints(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    
    if (!body?.order || !Array.isArray(body.order)) {
      return errorResponse('Order array is required');
    }
    
    // Verify trip ownership
    const trip = await env.DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    
    if (!trip) {
      return errorResponse('Trip not found', 404);
    }
    
    // Update each waypoint's order
    for (let i = 0; i < body.order.length; i++) {
      await env.DB.prepare(
        'UPDATE waypoints SET sort_order = ? WHERE id = ? AND trip_id = ?'
      ).bind(i, body.order[i], params.tripId).run();
    }
    
    await env.DB.prepare('UPDATE trips SET updated_at = datetime("now") WHERE id = ?').bind(params.tripId).run();
    
    return jsonResponse({ success: true });
  },
  
  /**
   * Add journal entry
   */
  async addJournalEntry(context) {
    const { env, user, params, request } = context;
    const body = await parseBody(request);
    
    // Verify trip ownership
    const trip = await env.DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    
    if (!trip) {
      return errorResponse('Trip not found', 404);
    }
    
    if (!body?.title) {
      return errorResponse('Title is required');
    }
    
    const id = generateId();
    
    await env.DB.prepare(
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
    
    await env.DB.prepare('UPDATE trips SET updated_at = datetime("now") WHERE id = ?').bind(params.tripId).run();
    
    const entry = await env.DB.prepare('SELECT * FROM journal_entries WHERE id = ?').bind(id).first();
    
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
    
    // Verify trip ownership
    const trip = await env.DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    
    if (!trip) {
      return errorResponse('Trip not found', 404);
    }
    
    const updates = [];
    const values = [];
    
    if (body.title !== undefined) { updates.push('title = ?'); values.push(body.title); }
    if (body.content !== undefined) { updates.push('content = ?'); values.push(body.content); }
    if (body.is_private !== undefined) { updates.push('is_private = ?'); values.push(body.is_private ? 1 : 0); }
    if (body.tags !== undefined) { updates.push('tags = ?'); values.push(JSON.stringify(body.tags)); }
    if (body.location !== undefined) { updates.push('location = ?'); values.push(JSON.stringify(body.location)); }
    
    if (updates.length > 0) {
      updates.push('updated_at = datetime("now")');
      values.push(params.id, params.tripId);
      
      await env.DB.prepare(
        `UPDATE journal_entries SET ${updates.join(', ')} WHERE id = ? AND trip_id = ?`
      ).bind(...values).run();
      
      await env.DB.prepare('UPDATE trips SET updated_at = datetime("now") WHERE id = ?').bind(params.tripId).run();
    }
    
    const entry = await env.DB.prepare('SELECT * FROM journal_entries WHERE id = ?').bind(params.id).first();
    
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
    
    // Verify trip ownership
    const trip = await env.DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    
    if (!trip) {
      return errorResponse('Trip not found', 404);
    }
    
    await env.DB.prepare(
      'DELETE FROM journal_entries WHERE id = ? AND trip_id = ?'
    ).bind(params.id, params.tripId).run();
    
    await env.DB.prepare('UPDATE trips SET updated_at = datetime("now") WHERE id = ?').bind(params.tripId).run();
    
    return jsonResponse({ success: true });
  },
  
  /**
   * Generate share link for trip (uses short code)
   */
  async generateShareLink(context) {
    const { env, user, params } = context;
    
    // Verify trip ownership
    const trip = await env.DB.prepare(
      'SELECT * FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.id, user.id).first();
    
    if (!trip) {
      return errorResponse('Trip not found', 404);
    }
    
    // Generate deterministic short code if missing (with collision retry)
    let shortCode = trip.short_code || generateShortCodeForId(trip.id);
    if (!trip.short_code) {
      let attempts = 0;
      while (attempts < 3) {
        try {
          await env.DB.prepare(
            'UPDATE trips SET short_code = ?, is_public = 1 WHERE id = ?'
          ).bind(shortCode, params.id).run();
          break;
        } catch (error) {
          if (error.message?.includes('UNIQUE constraint') && attempts < 2) {
            attempts++;
            shortCode = generateShortCodeForId(`${trip.id}:${attempts}`);
            continue;
          }
          throw error;
        }
      }
    } else {
      // Just mark as public
      await env.DB.prepare(
        'UPDATE trips SET is_public = 1 WHERE id = ?'
      ).bind(params.id).run();
    }
    
    // Clean root-level URL: ride.incitat.io/abc123
    const shareUrl = `${BASE_URL}/${shortCode}`;
    
    return jsonResponse({ shareUrl, shortCode });
  },
  
  /**
   * Get shared trip by short code (public access - no auth required)
   */
  async getSharedTrip(context) {
    const { env, params } = context;
    
    // Look up by short code
    const trip = await env.DB.prepare(
      'SELECT * FROM trips WHERE short_code = ?'
    ).bind(params.shortCode).first();
    
    if (!trip) {
      return errorResponse('Trip not found or not shared', 404);
    }

    if (!trip.is_public) {
      return errorResponse('Trip is not public', 403);
    }
    
    // Get waypoints
    const waypoints = await env.DB.prepare(
      'SELECT id, name, lat, lng, type, sort_order FROM waypoints WHERE trip_id = ? ORDER BY sort_order'
    ).bind(trip.id).all();
    
    // Get PUBLIC journal entries only (is_private = 0)
    const journal = await env.DB.prepare(
      'SELECT id, title, content, tags, created_at FROM journal_entries WHERE trip_id = ? AND is_private = 0 ORDER BY created_at DESC'
    ).bind(trip.id).all();
    
    // Get PUBLIC attachments only (is_private = 0)
    const attachments = await env.DB.prepare(
      'SELECT id, filename, original_name, mime_type, caption, is_cover FROM attachments WHERE trip_id = ? AND is_private = 0 ORDER BY is_cover DESC, created_at DESC'
    ).bind(trip.id).all();
    
    // Get route data
    const routeData = await env.DB.prepare(
      'SELECT * FROM route_data WHERE trip_id = ?'
    ).bind(trip.id).first();
    
    // Find cover image
    const coverImage = attachments.results.find(a => a.is_cover) || attachments.results.find(a => a.mime_type?.startsWith('image/'));
    const coverUrl = trip.cover_image_url || (coverImage ? `${BASE_URL}/api/attachments/${coverImage.id}` : null);
    
    // Return ONLY public-safe info (no user_id, no private notes, custom public title/desc)
    return jsonResponse({
      trip: {
        short_code: trip.short_code,
        title: trip.public_title || trip.name,
        description: trip.public_description || trip.description || '',
        contact: trip.public_contact || null,
        cover_image: coverUrl,
        created_at: trip.created_at,
        waypoints: waypoints.results.map(w => ({
          id: w.id,
          name: w.name,
          lat: w.lat,
          lng: w.lng,
          type: w.type,
          sort_order: w.sort_order
        })),
        journal: journal.results.map(e => ({
          id: e.id,
          title: e.title,
          content: e.content,
          tags: JSON.parse(e.tags || '[]'),
          created_at: e.created_at
        })),
        attachments: attachments.results.map(a => ({
          id: a.id,
          name: a.original_name,
          type: a.mime_type,
          caption: a.caption,
          url: `${BASE_URL}/api/attachments/${a.id}`
        })),
        route: routeData ? {
          coordinates: JSON.parse(routeData.coordinates || '[]'),
          distance: routeData.distance,
          duration: routeData.duration
        } : null
      }
    });
  },

  /**
   * Upload attachment to trip
   */
  async uploadAttachment(context) {
    const { env, user, params, request } = context;
    
    // Verify trip ownership
    const trip = await env.DB.prepare(
      'SELECT id FROM trips WHERE id = ? AND user_id = ?'
    ).bind(params.tripId, user.id).first();
    
    if (!trip) {
      return errorResponse('Trip not found', 404);
    }
    
    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file');
    
    if (!file) {
      return errorResponse('No file provided');
    }
    
    const id = generateId();
    const ext = file.name.split('.').pop() || 'bin';
    const storageKey = `trips/${params.tripId}/${id}.${ext}`;
    
    // Parse optional metadata
    const isPrivate = formData.get('is_private') === 'true' || formData.get('is_private') === '1';
    const isCover = formData.get('is_cover') === 'true' || formData.get('is_cover') === '1';
    const caption = formData.get('caption') || '';
    const journalEntryId = formData.get('journal_entry_id') || null;
    const waypointId = formData.get('waypoint_id') || null;

    // Validate scoped relations belong to this trip and user
    if (journalEntryId) {
      const journal = await env.DB.prepare(
        'SELECT je.id FROM journal_entries je JOIN trips t ON je.trip_id = t.id WHERE je.id = ? AND je.trip_id = ? AND t.user_id = ?'
      ).bind(journalEntryId, params.tripId, user.id).first();
      if (!journal) {
        return errorResponse('Journal entry not found for this trip', 404);
      }
    }

    if (waypointId) {
      const waypoint = await env.DB.prepare(
        'SELECT w.id FROM waypoints w JOIN trips t ON w.trip_id = t.id WHERE w.id = ? AND w.trip_id = ? AND t.user_id = ?'
      ).bind(waypointId, params.tripId, user.id).first();
      if (!waypoint) {
        return errorResponse('Waypoint not found for this trip', 404);
      }
    }

    // Upload to R2 then insert DB; cleanup R2 on DB failure
    let objectPutSucceeded = false;
    try {
      await env.ATTACHMENTS.put(storageKey, file.stream(), {
        httpMetadata: {
          contentType: file.type
        },
        customMetadata: {
          originalName: file.name,
          tripId: params.tripId
        }
      });
      objectPutSucceeded = true;
    
    // If setting as cover, unset other covers
    if (isCover) {
      await env.DB.prepare(
        'UPDATE attachments SET is_cover = 0 WHERE trip_id = ?'
      ).bind(params.tripId).run();
    }
    
      // Insert attachment record
      await env.DB.prepare(
        `INSERT INTO attachments (id, trip_id, journal_entry_id, waypoint_id, filename, original_name, mime_type, size_bytes, storage_key, is_private, is_cover, caption)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        params.tripId,
        journalEntryId,
        waypointId,
        `${id}.${ext}`,
        file.name,
        file.type,
        file.size,
        storageKey,
        isPrivate ? 1 : 0,
        isCover ? 1 : 0,
        caption
      ).run();
    
      // Update cover_image_url on trip if this is the cover
      if (isCover) {
        await env.DB.prepare(
          'UPDATE trips SET cover_image_url = ? WHERE id = ?'
        ).bind(`${BASE_URL}/api/attachments/${id}`, params.tripId).run();
      }
    
      await env.DB.prepare('UPDATE trips SET updated_at = datetime("now") WHERE id = ?').bind(params.tripId).run();

      const attachment = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first();

      return jsonResponse({
        attachment: {
          ...attachment,
          url: `${BASE_URL}/api/attachments/${id}`
        }
      }, 201);
    } catch (err) {
      if (objectPutSucceeded) {
        try { await env.ATTACHMENTS.delete(storageKey); } catch (_) {}
      }
      throw err;
    }
  },

  /**
   * Get attachment file (supports public access for public attachments)
   */
  async getAttachment(context) {
    const { env, params, user } = context;
    
    const attachment = await env.DB.prepare(
      'SELECT a.*, t.user_id, t.is_public as trip_is_public FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE a.id = ?'
    ).bind(params.id).first();
    
    if (!attachment) {
      return errorResponse('Attachment not found', 404);
    }
    
    // Check access: owner can see all, public can see public attachments of public trips
    const isOwner = user && user.id === attachment.user_id;
    const isPubliclyAccessible = attachment.trip_is_public && !attachment.is_private;
    
    if (!isOwner && !isPubliclyAccessible) {
      return errorResponse('Attachment not found', 404);
    }
    
    // Fetch from R2
    const object = await env.ATTACHMENTS.get(attachment.storage_key);
    
    if (!object) {
      return errorResponse('File not found', 404);
    }
    
    const headers = new Headers();
    headers.set('Content-Type', attachment.mime_type);
    headers.set('Content-Length', attachment.size_bytes);
    headers.set('Cache-Control', 'public, max-age=31536000');
    
    // For images, allow inline display
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
    
    // Verify ownership through trip
    const attachment = await env.DB.prepare(
      'SELECT a.*, t.user_id FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE a.id = ?'
    ).bind(params.id).first();
    
    if (!attachment || attachment.user_id !== user.id) {
      return errorResponse('Attachment not found', 404);
    }
    
    const updates = [];
    const values = [];
    
    if (body.caption !== undefined) {
      updates.push('caption = ?');
      values.push(body.caption);
    }
    if (body.is_private !== undefined) {
      updates.push('is_private = ?');
      values.push(body.is_private ? 1 : 0);
    }
    if (body.is_cover !== undefined) {
      if (body.is_cover) {
        // Unset other covers first
        await env.DB.prepare('UPDATE attachments SET is_cover = 0 WHERE trip_id = ?').bind(attachment.trip_id).run();
        await env.DB.prepare('UPDATE trips SET cover_image_url = ? WHERE id = ?').bind(`${BASE_URL}/api/attachments/${params.id}`, attachment.trip_id).run();
      }
      updates.push('is_cover = ?');
      values.push(body.is_cover ? 1 : 0);
      if (!body.is_cover) {
        // If unsetting cover, clear or recompute cover_image_url
        const fallback = await env.DB.prepare(
          'SELECT id FROM attachments WHERE trip_id = ? AND is_cover = 1 AND id != ? ORDER BY created_at DESC'
        ).bind(attachment.trip_id, params.id).first();
        if (fallback) {
          await env.DB.prepare('UPDATE trips SET cover_image_url = ? WHERE id = ?').bind(`${BASE_URL}/api/attachments/${fallback.id}`, attachment.trip_id).run();
        } else {
          await env.DB.prepare('UPDATE trips SET cover_image_url = NULL WHERE id = ?').bind(attachment.trip_id).run();
        }
      }
    }
    
    if (updates.length > 0) {
      values.push(params.id);
      await env.DB.prepare(`UPDATE attachments SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    }
    
    const updated = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(params.id).first();
    
    return jsonResponse({
      attachment: {
        ...updated,
        url: `${BASE_URL}/api/attachments/${params.id}`
      }
    });
  },

  /**
   * Delete attachment
   */
  async deleteAttachment(context) {
    const { env, user, params } = context;
    
    // Verify ownership through trip
    const attachment = await env.DB.prepare(
      'SELECT a.*, t.user_id FROM attachments a JOIN trips t ON a.trip_id = t.id WHERE a.id = ?'
    ).bind(params.id).first();
    
    if (!attachment || attachment.user_id !== user.id) {
      return errorResponse('Attachment not found', 404);
    }
    
    // Delete from R2
    await env.ATTACHMENTS.delete(attachment.storage_key);
    
    // Delete from DB
    await env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(params.id).run();

    // If the deleted attachment was the cover, recompute cover_image_url
    if (attachment.is_cover) {
      const fallback = await env.DB.prepare(
        'SELECT id FROM attachments WHERE trip_id = ? AND is_cover = 1 ORDER BY created_at DESC'
      ).bind(attachment.trip_id).first();
      if (fallback) {
        await env.DB.prepare('UPDATE trips SET cover_image_url = ? WHERE id = ?').bind(`${BASE_URL}/api/attachments/${fallback.id}`, attachment.trip_id).run();
      } else {
        await env.DB.prepare('UPDATE trips SET cover_image_url = NULL WHERE id = ?').bind(attachment.trip_id).run();
      }
    }
    
    return jsonResponse({ success: true });
  }
};
