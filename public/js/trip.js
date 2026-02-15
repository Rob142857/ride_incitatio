/**
 * Trip module - handles trip data structure and operations
 */
const Trip = {
  /**
   * Create a new trip object
   */
  create(name = 'New Trip') {
    return {
      id: Storage.generateId(),
      name: name,
      description: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      waypoints: [],
      route: null,
      journal: [],
      coverImageUrl: '',
      cover_image_url: '',
      coverFocusX: 50,
      cover_focus_x: 50,
      coverFocusY: 50,
      cover_focus_y: 50,
      isPublic: false,
      is_public: 0,
      shortCode: null,
      short_code: null,
      shareId: null,
      share_id: null,
      version: 0,
      settings: {
        routingProfile: 'driving'
      }
    };
  },

  /**
   * Normalize waypoint ordering (maps sort_order -> order and sorts array)
   */
  normalizeWaypointOrder(waypoints = []) {
    return (Array.isArray(waypoints) ? waypoints : []).map((wp, idx) => {
      return { ...wp, order: idx };
    });
  },

  /**
   * Create a waypoint object
   */
  createWaypoint(data) {
    return {
      id: Storage.generateId(),
      name: data.name || 'Waypoint',
      lat: data.lat,
      lng: data.lng,
      type: data.type || 'stop',
      notes: data.notes || '',
      order: data.order || 0,
      createdAt: new Date().toISOString()
    };
  },

  /**
   * Add waypoint to trip
   */
  addWaypoint(trip, waypointData) {
    const waypoint = this.createWaypoint({
      ...waypointData,
      order: trip.waypoints.length
    });
    trip.waypoints.push(waypoint);
    trip.updatedAt = new Date().toISOString();
    return waypoint;
  },

  /**
   * Update waypoint in trip
   */
  updateWaypoint(trip, waypointId, data) {
    const index = trip.waypoints.findIndex(w => w.id === waypointId);
    if (index >= 0) {
      trip.waypoints[index] = { ...trip.waypoints[index], ...data };
      trip.updatedAt = new Date().toISOString();
      return trip.waypoints[index];
    }
    return null;
  },

  /**
   * Remove waypoint from trip
   */
  removeWaypoint(trip, waypointId) {
    trip.waypoints = trip.waypoints.filter(w => w.id !== waypointId);
    trip.waypoints.forEach((w, i) => {
      w.order = i;
    });
    trip.updatedAt = new Date().toISOString();
  },

  /**
   * Reorder waypoints
   */
  reorderWaypoints(trip, waypointIds) {
    const existing = Array.isArray(trip?.waypoints) ? trip.waypoints : [];
    const byId = new Map(existing.map((w) => [w.id, w]));

    const reordered = [];
    const seen = new Set();
    (Array.isArray(waypointIds) ? waypointIds : []).forEach((id) => {
      const waypoint = byId.get(id);
      if (!waypoint || seen.has(id)) return;
      seen.add(id);
      reordered.push(waypoint);
    });

    // Append any waypoints that were not present in waypointIds (defensive)
    existing.forEach((w) => {
      if (w && w.id && !seen.has(w.id)) reordered.push(w);
    });

    reordered.forEach((w, idx) => {
      w.order = idx;
    });

    trip.waypoints = reordered;
    trip.updatedAt = new Date().toISOString();
  },

  /**
   * Remove journal entry
   */
  removeJournalEntry(trip, entryId) {
    trip.journal = trip.journal.filter(e => e.id !== entryId);
    trip.updatedAt = new Date().toISOString();
  },

  /**
   * Get public journal entries only
   */
  getPublicJournal(trip) {
    return trip.journal.filter(e => !e.isPrivate);
  },

  /**
   * Calculate trip statistics
   */
  getStats(trip) {
    const waypoints = Array.isArray(trip.waypoints) ? trip.waypoints : [];
    const journal = Array.isArray(trip.journal) ? trip.journal : [];
    return {
      waypointCount: waypoints.length,
      journalCount: journal.length,
      publicNotesCount: journal.filter(e => !e.isPrivate).length,
      privateNotesCount: journal.filter(e => e.isPrivate).length
    };
  },

  /**
   * Get shareable version of trip (without private data)
   */
  getShareableData(trip, options = {}) {
    const includeWaypoints = options.includeWaypoints !== false;
    const includeRoute = options.includeRoute !== false;
    const includePublicNotes = options.includePublicNotes !== false;

    return {
      id: trip.shareId || trip.shortCode || trip.id,
      name: trip.name,
      description: trip.description,
      coverImageUrl: trip.coverImageUrl || trip.cover_image_url || '',
      coverFocusX: trip.coverFocusX ?? trip.cover_focus_x ?? 50,
      coverFocusY: trip.coverFocusY ?? trip.cover_focus_y ?? 50,
      waypoints: includeWaypoints ? trip.waypoints : [],
      route: includeRoute ? trip.route : null,
      journal: includePublicNotes ? this.getPublicJournal(trip) : [],
      createdAt: trip.createdAt,
      stats: this.getStats(trip)
    };
  },

  /**
   * Export trip to GPX format
   */
  toGPX(trip) {
    const waypoints = trip.waypoints.map(w => 
      `  <wpt lat="${w.lat}" lon="${w.lng}">
    <name>${this.escapeXml(w.name)}</name>
    <desc>${this.escapeXml(w.notes)}</desc>
    <type>${w.type}</type>
  </wpt>`
    ).join('\n');

    let route = '';
    if (trip.customRoutePoints && trip.customRoutePoints.length > 0) {
      const rtepts = trip.customRoutePoints.map(p => 
        `    <rtept lat="${p.lat}" lon="${p.lng}"></rtept>`
      ).join('\n');
      route = `  <rte>
    <name>${this.escapeXml(trip.name)}</name>
${rtepts}
  </rte>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ride Trip Planner"
  xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${this.escapeXml(trip.name)}</name>
    <desc>${this.escapeXml(trip.description)}</desc>
    <time>${trip.createdAt}</time>
  </metadata>
${waypoints}
${route}
</gpx>`;
  },

  /**
   * Escape XML special characters
   */
  escapeXml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  },

  /**
   * Import from GPX
   */
  fromGPX(gpxString, tripName = 'Imported Trip') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(gpxString, 'application/xml');
    
    const trip = this.create(tripName);
    
    // Parse waypoints
    const wpts = doc.querySelectorAll('wpt');
    wpts.forEach((wpt, index) => {
      const name = wpt.querySelector('name')?.textContent || `Waypoint ${index + 1}`;
      const desc = wpt.querySelector('desc')?.textContent || '';
      const type = wpt.querySelector('type')?.textContent || 'stop';
      
      this.addWaypoint(trip, {
        name,
        notes: desc,
        type,
        lat: parseFloat(wpt.getAttribute('lat')),
        lng: parseFloat(wpt.getAttribute('lon'))
      });
    });

    // Parse route points
    const rtepts = doc.querySelectorAll('rtept');
    if (rtepts.length > 0) {
      trip.customRoutePoints = Array.from(rtepts).map(pt => ({
        lat: parseFloat(pt.getAttribute('lat')),
        lng: parseFloat(pt.getAttribute('lon'))
      }));
    }

    return trip;
  }
};

// Make available globally
window.Trip = Trip;
