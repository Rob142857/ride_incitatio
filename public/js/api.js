/**
 * API Client - handles all backend communication
 */
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
      return data.trips;
    },

    async get(id) {
      const data = await API.request(`/trips/${id}`);
      return data.trip;
    },

    async create(tripData) {
      const data = await API.request('/trips', {
        method: 'POST',
        body: tripData,
      });
      return data.trip;
    },

    async update(id, tripData) {
      const data = await API.request(`/trips/${id}`, {
        method: 'PUT',
        body: tripData,
      });
      return data.trip;
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
    async add(tripId, waypointData) {
      const data = await API.request(`/trips/${tripId}/waypoints`, {
        method: 'POST',
        body: waypointData,
      });
      return data.waypoint;
    },

    async update(tripId, waypointId, waypointData) {
      const data = await API.request(`/trips/${tripId}/waypoints/${waypointId}`, {
        method: 'PUT',
        body: waypointData,
      });
      return data.waypoint;
    },

    async delete(tripId, waypointId) {
      await API.request(`/trips/${tripId}/waypoints/${waypointId}`, {
        method: 'DELETE',
      });
    },

    async reorder(tripId, orderArray) {
      await API.request(`/trips/${tripId}/waypoints/reorder`, {
        method: 'PUT',
        body: { order: orderArray },
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
      return data.entry;
    },

    async update(tripId, entryId, entryData) {
      const data = await API.request(`/trips/${tripId}/journal/${entryId}`, {
        method: 'PUT',
        body: entryData,
      });
      return data.entry;
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
      formData.append('is_cover', options.is_cover ? 'true' : 'false');

      const data = await fetch(`${API.baseUrl}/trips/${tripId}/attachments`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      }).then(async (res) => {
        let body;
        try {
          body = await res.json();
        } catch (_) {
          const text = await res.text();
          body = text ? { error: text } : {};
        }
        if (!res.ok) {
          const err = new Error(body.error || `Upload failed (${res.status})`);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });

      return data.attachment;
    },
  },
};
