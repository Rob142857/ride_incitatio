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
      customRoutePoints: [],
      journal: [],
      cover_image_url: '',
      is_public: false,
      short_code: null,
      settings: {
        routingProfile: 'driving',
        avoidTolls: false,
        avoidHighways: false
      },
      shareSettings: {
        isPublic: false,
        shareId: null,
        includePrivateNotes: false
      }
    };
  },

  /**
   * Create a waypoint object
   */
  createWaypoint(data) {
    return {
      id: Storage.generateId(),
      name: data.name || 'Waypoint',
      address: data.address || '',
      lat: data.lat,
      lng: data.lng,
      type: data.type || 'stop',
      notes: data.notes || '',
      order: data.order || 0,
      createdAt: new Date().toISOString()
    };
  },

  /**
   * Create a journal entry
   */
  createJournalEntry(data) {
    return {
      id: Storage.generateId(),
      title: data.title || 'Note',
      content: data.content || '',
      isPrivate: data.isPrivate || false,
      tags: data.tags || [],
      waypointId: data.waypointId || null,
      location: data.location || null,
      photos: data.photos || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
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
    // Reorder remaining waypoints
    trip.waypoints.forEach((w, i) => w.order = i);
    trip.updatedAt = new Date().toISOString();
  },

  /**
   * Reorder waypoints
   */
  reorderWaypoints(trip, waypointIds) {
    const reordered = [];
    waypointIds.forEach((id, index) => {
      const waypoint = trip.waypoints.find(w => w.id === id);
      if (waypoint) {
        waypoint.order = index;
        reordered.push(waypoint);
      }
    });
    trip.waypoints = reordered;
    trip.updatedAt = new Date().toISOString();
  },

  /**
   * Add journal entry to trip
   */
  addJournalEntry(trip, entryData) {
    const entry = this.createJournalEntry(entryData);
    trip.journal.push(entry);
    trip.updatedAt = new Date().toISOString();
    return entry;
  },

  /**
   * Update journal entry
   */
  updateJournalEntry(trip, entryId, data) {
    const index = trip.journal.findIndex(e => e.id === entryId);
    if (index >= 0) {
      trip.journal[index] = {
        ...trip.journal[index],
        ...data,
        updatedAt: new Date().toISOString()
      };
      trip.updatedAt = new Date().toISOString();
      return trip.journal[index];
    }
    return null;
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
   * Set custom route points (for drag-to-adjust functionality)
   */
  setCustomRoutePoints(trip, points) {
    trip.customRoutePoints = points;
    trip.updatedAt = new Date().toISOString();
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
   * Generate share ID if not exists
   */
  generateShareId(trip) {
    this.ensureShareSettings(trip);
    if (!trip.shareSettings.shareId) {
      trip.shareSettings.shareId = trip.share_id || trip.short_code || Storage.generateId();
    }
    return trip.shareSettings.shareId;
  },

  /**
   * Ensure shareSettings exists and is aligned with server fields
   */
  ensureShareSettings(trip) {
    if (!trip) return trip;
    if (!trip.shareSettings) {
      trip.shareSettings = {
        shareId: trip.share_id || trip.short_code || Storage.generateId(),
        isPublic: !!trip.is_public,
        includePrivateNotes: false
      };
    } else {
      trip.shareSettings.shareId = trip.shareSettings.shareId || trip.share_id || trip.short_code || Storage.generateId();
      trip.shareSettings.isPublic = trip.shareSettings.isPublic ?? !!trip.is_public;
      if (trip.shareSettings.includePrivateNotes === undefined) {
        trip.shareSettings.includePrivateNotes = false;
      }
    }
    return trip;
  },

  /**
   * Get shareable version of trip (without private data)
   */
  getShareableData(trip, options = {}) {
    const includeWaypoints = options.includeWaypoints !== false;
    const includeRoute = options.includeRoute !== false;
    const includePublicNotes = options.includePublicNotes !== false;

    return {
      id: trip.shareSettings.shareId || trip.id,
      name: trip.name,
      description: trip.description,
      cover_image: trip.cover_image_url || null,
      waypoints: includeWaypoints ? trip.waypoints : [],
      route: includeRoute ? trip.route : null,
      customRoutePoints: includeRoute ? trip.customRoutePoints : [],
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
