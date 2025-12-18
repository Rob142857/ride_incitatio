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
    
    const config = {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      credentials: 'include', // Include cookies for session
      cache: 'no-store'
    };
    
    if (options.body && typeof options.body === 'object') {
      config.body = JSON.stringify(options.body);
    }
    
    try {
      const response = await fetch(url, config);
      const data = await response.json();

      if (!response.ok) {
        const err = new Error(data.error || 'Request failed');
        err.status = response.status;
        throw err;
      }

      return data;
    } catch (error) {
      console.error('API Error:', error);
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
    }
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
        body: tripData
      });
      return data.trip;
    },
    
    async update(id, tripData) {
      const data = await API.request(`/trips/${id}`, {
        method: 'PUT',
        body: tripData
      });
      return data.trip;
    },
    
    async delete(id) {
      await API.request(`/trips/${id}`, { method: 'DELETE' });
    },
    
    async share(id) {
      const data = await API.request(`/trips/${id}/share`, { method: 'POST' });
      return data;
    }
  },
  
  // Waypoint methods
  waypoints: {
    async add(tripId, waypointData) {
      const data = await API.request(`/trips/${tripId}/waypoints`, {
        method: 'POST',
        body: waypointData
      });
      return data.waypoint;
    },
    
    async update(tripId, waypointId, waypointData) {
      const data = await API.request(`/trips/${tripId}/waypoints/${waypointId}`, {
        method: 'PUT',
        body: waypointData
      });
      return data.waypoint;
    },
    
    async delete(tripId, waypointId) {
      await API.request(`/trips/${tripId}/waypoints/${waypointId}`, {
        method: 'DELETE'
      });
    },
    
    async reorder(tripId, orderArray) {
      await API.request(`/trips/${tripId}/waypoints/reorder`, {
        method: 'PUT',
        body: { order: orderArray }
      });
    }
  },
  
  // Journal methods
  journal: {
    async add(tripId, entryData) {
      const data = await API.request(`/trips/${tripId}/journal`, {
        method: 'POST',
        body: entryData
      });
      return data.entry;
    },
    
    async update(tripId, entryId, entryData) {
      const data = await API.request(`/trips/${tripId}/journal/${entryId}`, {
        method: 'PUT',
        body: entryData
      });
      return data.entry;
    },
    
    async delete(tripId, entryId) {
      await API.request(`/trips/${tripId}/journal/${entryId}`, {
        method: 'DELETE'
      });
    }
  },
  
  // Attachment methods
  attachments: {
    async upload(tripId, file, options = {}) {
      const formData = new FormData();
      formData.append('file', file);
      
      if (options.is_private) formData.append('is_private', 'true');
      if (options.is_cover) formData.append('is_cover', 'true');
      if (options.caption) formData.append('caption', options.caption);
      if (options.journal_entry_id) formData.append('journal_entry_id', options.journal_entry_id);
      if (options.waypoint_id) formData.append('waypoint_id', options.waypoint_id);
      
      const response = await fetch(`${API.baseUrl}/trips/${tripId}/attachments`, {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });
      
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed');
      return data.attachment;
    },
    
    async update(attachmentId, updateData) {
      const data = await API.request(`/attachments/${attachmentId}`, {
        method: 'PUT',
        body: updateData
      });
      return data.attachment;
    },
    
    async delete(attachmentId) {
      await API.request(`/attachments/${attachmentId}`, { method: 'DELETE' });
    },
    
    getUrl(attachmentId) {
      return `${API.baseUrl}/attachments/${attachmentId}`;
    }
  },
  
  // Shared trip (public) - uses short code at root
  shared: {
    async get(shortCode) {
      const data = await API.request(`/s/${shortCode}`);
      return data.trip;
    }
  }
};

// Make available globally
window.API = API;
