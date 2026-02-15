/**
 * API Client - handles all backend communication
 *
 * Normalization layer: all server responses go through normalize helpers
 * that map snake_case DB fields → consistent camelCase for the client.
 * The client always works with camelCase; snake_case only exists in API
 * request bodies sent TO the server (which expects them).
 */

/** Normalize a single journal entry from server snake_case → client camelCase */
function _normalizeEntry(e) {
  if (!e) return e;
  return {
    ...e,
    isPrivate: !!(e.is_private ?? e.isPrivate),
    waypointId: e.waypoint_id ?? e.waypointId ?? null,
    createdAt: e.created_at ?? e.createdAt,
    updatedAt: e.updated_at ?? e.updatedAt,
    tags: typeof e.tags === 'string' ? JSON.parse(e.tags) : (e.tags || []),
    location: typeof e.location === 'string' ? JSON.parse(e.location) : (e.location || null),
    attachments: e.attachments || [],
  };
}

/** Normalize a single attachment from server snake_case → client camelCase */
function _normalizeAttachment(a) {
  if (!a) return a;
  return {
    ...a,
    journalEntryId: a.journal_entry_id ?? a.journalEntryId ?? null,
    waypointId: a.waypoint_id ?? a.waypointId ?? null,
    originalName: a.original_name ?? a.originalName ?? a.filename,
    mimeType: a.mime_type ?? a.mimeType,
    sizeBytes: a.size_bytes ?? a.sizeBytes,
    isCover: !!(a.is_cover ?? a.isCover),
    isPrivate: !!(a.is_private ?? a.isPrivate),
    createdAt: a.created_at ?? a.createdAt,
  };
}

/** Normalize a single waypoint from server snake_case → client camelCase */
function _normalizeWaypoint(w) {
  if (!w) return w;
  return {
    ...w,
    order: w.sort_order ?? w.order ?? 0,
    createdAt: w.created_at ?? w.createdAt,
  };
}

/** Normalize a full trip (with embedded waypoints, journal, attachments, route) */
function _normalizeTrip(t) {
  if (!t) return t;
  const trip = {
    ...t,
    createdAt: t.created_at ?? t.createdAt,
    updatedAt: t.updated_at ?? t.updatedAt,
    isPublic: !!(t.is_public ?? t.isPublic),
    coverImageUrl: t.cover_image_url ?? t.coverImageUrl ?? '',
    coverFocusX: Number.isFinite(t.cover_focus_x) ? t.cover_focus_x : (Number.isFinite(t.coverFocusX) ? t.coverFocusX : 50),
    coverFocusY: Number.isFinite(t.cover_focus_y) ? t.cover_focus_y : (Number.isFinite(t.coverFocusY) ? t.coverFocusY : 50),
    shortCode: t.short_code ?? t.shortCode ?? null,
    shortUrl: t.short_url ?? t.shortUrl ?? null,
    shareId: t.share_id ?? t.shareId ?? null,
    settings: typeof t.settings === 'string' ? JSON.parse(t.settings || '{}') : (t.settings || {}),
    version: Number(t.version ?? 0),
  };
  // Also keep snake_case aliases for server round-trips (update payloads)
  trip.is_public = trip.isPublic ? 1 : 0;
  trip.cover_image_url = trip.coverImageUrl;
  trip.cover_focus_x = trip.coverFocusX;
  trip.cover_focus_y = trip.coverFocusY;
  trip.short_code = trip.shortCode;
  trip.short_url = trip.shortUrl;
  trip.share_id = trip.shareId;

  if (Array.isArray(trip.waypoints)) trip.waypoints = trip.waypoints.map(_normalizeWaypoint);
  if (Array.isArray(trip.journal)) trip.journal = trip.journal.map(_normalizeEntry);
  if (Array.isArray(trip.attachments)) trip.attachments = trip.attachments.map(_normalizeAttachment);
  if (trip.route) {
    const duration = trip.route.duration ?? trip.route.time ?? null;
    trip.route = { ...trip.route, duration, time: duration, coordinates: trip.route.coordinates || [] };
  }
  return trip;
}

/** Normalize a trip-list item (no embedded children) */
function _normalizeTripSummary(t) {
  if (!t) return t;
  return {
    ...t,
    createdAt: t.created_at ?? t.createdAt,
    updatedAt: t.updated_at ?? t.updatedAt,
    isPublic: !!(t.is_public ?? t.isPublic),
    shortCode: t.short_code ?? t.shortCode ?? null,
    shortUrl: t.short_url ?? t.shortUrl ?? null,
    // keep snake_case aliases for UI compat
    is_public: !!(t.is_public ?? t.isPublic),
    short_code: t.short_code ?? t.shortCode ?? null,
    short_url: t.short_url ?? t.shortUrl ?? null,
  };
}

const API = {
  baseUrl: '/api',

  /**
   * Make authenticated request
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;

    const isForm = options.body instanceof FormData;
    const defaultHeaders = isForm
      ? {
          'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        }
      : {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        };

    const config = {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers,
      },
      credentials: 'include', // Include cookies for session
      cache: 'no-store',
    };

    if (options.body && typeof options.body === 'object' && !isForm) {
      config.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, config);
      let data;
      try {
        data = await response.json();
      } catch (_) {
        // Fallback for non-JSON responses (HTML error pages, empty bodies)
        const text = await response.text();
        data = text ? { error: text } : {};
      }

      if (!response.ok) {
        // Centralize auth-expired handling so UI can fail-closed.
        if (response.status === 401 && typeof window !== 'undefined') {
          try {
            window.dispatchEvent(new CustomEvent('ride:auth-expired', {
              detail: { endpoint, status: response.status }
            }));
          } catch (_) {
            // ignore
          }
        }

        // Treat server-side failures as a lost connection (fail closed).
        if (response.status >= 500 && typeof window !== 'undefined') {
          try {
            window.dispatchEvent(new CustomEvent('ride:connection-lost', {
              detail: { endpoint, status: response.status, kind: 'server' }
            }));
          } catch (_) {
            // ignore
          }
        }
        const err = new Error(data.error || data.message || `Request failed (${response.status})`);
        err.status = response.status;
        err.body = data;
        throw err;
      }

      return data;
    } catch (error) {
      console.error('API Error:', error);
      // Normalize network failures
      if (!error.status) {
        error.status = 0;
        error.message = error.message || 'Network error';
      }

      if (error.status === 0 && typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('ride:connection-lost', {
            detail: { endpoint, status: 0, kind: 'network' }
          }));
        } catch (_) {
          // ignore
        }
      }
      throw error;
    }
  },

  // Auth methods
  auth: {
    async getUser() {
      try {
        const data = await API.request('/auth/me');
        return data.user;
      } catch (err) {
        if (err.status === 401) return null;
        throw err;
      }
    },

    loginUrl(provider, returnTo) {
      const suffix = returnTo ? `?return=${encodeURIComponent(returnTo)}` : '';
      return `${API.baseUrl}/auth/login/${provider}${suffix}`;
    },

    async logout() {
      await API.request('/auth/logout', { method: 'POST' });
    },
  },

  // Trip methods
  trips: {
    async list() {
      const data = await API.request('/trips');
      return (data.trips || []).map(_normalizeTripSummary);
    },

    async get(id) {
      const data = await API.request(`/trips/${id}`);
      return _normalizeTrip(data.trip);
    },

    async create(tripData) {
      const data = await API.request('/trips', {
        method: 'POST',
        body: tripData,
      });
      return _normalizeTrip(data.trip);
    },

    async update(id, tripData, options = {}) {
      const data = await API.request(`/trips/${id}`, {
        method: 'PUT',
        body: tripData,
        ...(options || {}),
      });
      return _normalizeTrip(data.trip);
    },

    async delete(id) {
      await API.request(`/trips/${id}`, { method: 'DELETE' });
    },

    async share(id) {
      const data = await API.request(`/trips/${id}/share`, { method: 'POST' });
      return data;
    },
  },

  // Waypoint methods
  waypoints: {
    async add(tripId, waypointData, options = {}) {
      return await API.request(`/trips/${tripId}/waypoints`, {
        method: 'POST',
        body: waypointData,
        ...(options || {}),
      });
    },

    async update(tripId, waypointId, waypointData, options = {}) {
      return await API.request(`/trips/${tripId}/waypoints/${waypointId}`, {
        method: 'PUT',
        body: waypointData,
        ...(options || {}),
      });
    },

    async delete(tripId, waypointId, options = {}) {
      return await API.request(`/trips/${tripId}/waypoints/${waypointId}`, {
        method: 'DELETE',
        ...(options || {}),
      });
    },

    async reorder(tripId, orderArray, options = {}) {
      return await API.request(`/trips/${tripId}/waypoints/reorder`, {
        method: 'PUT',
        body: { order: orderArray },
        ...(options || {}),
      });
    },
  },

  // Journal methods
  journal: {
    async add(tripId, entryData) {
      const data = await API.request(`/trips/${tripId}/journal`, {
        method: 'POST',
        body: entryData,
      });
      return _normalizeEntry(data.entry);
    },

    async update(tripId, entryId, entryData) {
      const data = await API.request(`/trips/${tripId}/journal/${entryId}`, {
        method: 'PUT',
        body: entryData,
      });
      return _normalizeEntry(data.entry);
    },

    async delete(tripId, entryId) {
      await API.request(`/trips/${tripId}/journal/${entryId}`, {
        method: 'DELETE',
      });
    },
  },

  // Attachment methods
  attachments: {
    async upload(tripId, file, options = {}) {
      const formData = new FormData();
      formData.append('file', file);
      if (options.is_cover !== undefined) formData.append('is_cover', options.is_cover ? 'true' : 'false');
      if (options.is_private !== undefined) formData.append('is_private', options.is_private ? 'true' : 'false');
      if (options.caption !== undefined) formData.append('caption', String(options.caption || ''));
      if (options.journal_entry_id) formData.append('journal_entry_id', options.journal_entry_id);
      if (options.waypoint_id) formData.append('waypoint_id', options.waypoint_id);

      const data = await API.request(`/trips/${tripId}/attachments`, {
        method: 'POST',
        body: formData,
        headers: options.headers || {},
      });
      return _normalizeAttachment(data.attachment);
    },

    async delete(attachmentId, options = {}) {
      return API.request(`/attachments/${attachmentId}`, {
        method: 'DELETE',
        headers: options.headers || {},
      });
    },

    async update(attachmentId, data) {
      const result = await API.request(`/attachments/${attachmentId}`, {
        method: 'PUT',
        body: data,
      });
      return _normalizeAttachment(result.attachment);
    },
  },

  // Places search (Google Places via backend proxy)
  places: {
    async search(query, options = {}) {
      const params = new URLSearchParams({ q: query });
      if (options.lat != null && options.lng != null) {
        params.set('lat', options.lat);
        params.set('lng', options.lng);
      }
      if (options.radius) params.set('radius', options.radius);
      if (options.region) params.set('region', options.region);
      const data = await API.request(`/places/search?${params}`);
      return data.results || [];
    },
  },
};
