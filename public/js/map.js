/**
 * Map module - handles Leaflet map and routing
 */
const MapManager = {
  map: null,
  routingControl: null,
  waypointMarkers: {},
  isAddingWaypoint: false,
  pendingLocation: null,

  // Waypoint type icons
  waypointIcons: {
    stop: { color: '#e94560', icon: '📍' },
    scenic: { color: '#4ade80', icon: '🏞️' },
    fuel: { color: '#fbbf24', icon: '⛽' },
    food: { color: '#f97316', icon: '🍽️' },
    lodging: { color: '#8b5cf6', icon: '🏨' },
    custom: { color: '#06b6d4', icon: '⭐' }
  },

  /**
   * Initialize the map
   */
  init() {
    // Create map centered on Colinroobie, NSW
    this.map = L.map('map', {
      zoomControl: false,
      attributionControl: true
    }).setView([-34.5386, 146.5933], 12);

    // Add tile layer (OpenStreetMap)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(this.map);

    // Add zoom control to bottom left (away from nav)
    L.control.zoom({ position: 'bottomleft' }).addTo(this.map);

    // Try to get user's location
    this.locateUser();

    // Map click handler for adding waypoints
    this.map.on('click', (e) => this.handleMapClick(e));

    // Handle resize
    window.addEventListener('resize', () => {
      this.map.invalidateSize();
    });

    return this;
  },

  /**
   * Locate user and center map
   */
  locateUser() {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          this.map.setView([latitude, longitude], 13);
        },
        (error) => {
          console.log('Geolocation error:', error);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }
  },

  /**
   * Handle map click
   */
  handleMapClick(e) {
    if (this.isAddingWaypoint) {
      this.pendingLocation = { lat: e.latlng.lat, lng: e.latlng.lng };
      
      // Update the modal inputs if open
      const latInput = document.getElementById('waypointLat');
      const lngInput = document.getElementById('waypointLng');
      if (latInput && lngInput) {
        latInput.value = e.latlng.lat.toFixed(6);
        lngInput.value = e.latlng.lng.toFixed(6);
      }

      // Show temporary marker
      if (this.tempMarker) {
        this.tempMarker.setLatLng(e.latlng);
      } else {
        this.tempMarker = L.marker(e.latlng, {
          icon: this.createIcon('custom')
        }).addTo(this.map);
      }
    }
  },

  /**
   * Enable waypoint adding mode
   */
  enableAddWaypointMode() {
    this.isAddingWaypoint = true;
    this.map.getContainer().style.cursor = 'crosshair';
    UI.showToast('Tap on map to set location', 'info');
  },

  /**
   * Disable waypoint adding mode
   */
  disableAddWaypointMode() {
    this.isAddingWaypoint = false;
    this.map.getContainer().style.cursor = '';
    this.pendingLocation = null;
    
    if (this.tempMarker) {
      this.map.removeLayer(this.tempMarker);
      this.tempMarker = null;
    }
  },

  /**
   * Create custom icon for waypoint type
   */
  createIcon(type) {
    const config = this.waypointIcons[type] || this.waypointIcons.stop;
    
    return L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        background: ${config.color};
        width: 36px;
        height: 36px;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        border: 2px solid white;
      "><span style="transform: rotate(45deg); font-size: 16px;">${config.icon}</span></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 36],
      popupAnchor: [0, -36]
    });
  },

  /**
   * Add waypoint marker to map
   */
  addWaypointMarker(waypoint) {
    const marker = L.marker([waypoint.lat, waypoint.lng], {
      icon: this.createIcon(waypoint.type),
      draggable: true
    }).addTo(this.map);

    // Popup with waypoint info
    marker.bindPopup(`
      <div style="min-width: 150px;">
        <strong>${waypoint.name}</strong>
        ${waypoint.notes ? `<p style="margin: 8px 0 0; font-size: 12px;">${waypoint.notes}</p>` : ''}
      </div>
    `);

    // Handle drag end
    marker.on('dragend', (e) => {
      const newPos = e.target.getLatLng();
      App.updateWaypointPosition(waypoint.id, newPos.lat, newPos.lng);
    });

    this.waypointMarkers[waypoint.id] = marker;
    return marker;
  },

  /**
   * Remove waypoint marker
   */
  removeWaypointMarker(waypointId) {
    if (this.waypointMarkers[waypointId]) {
      this.map.removeLayer(this.waypointMarkers[waypointId]);
      delete this.waypointMarkers[waypointId];
    }
  },

  /**
   * Update all waypoint markers from trip
   */
  updateWaypoints(waypoints) {
    // Clear existing markers
    Object.keys(this.waypointMarkers).forEach(id => {
      this.map.removeLayer(this.waypointMarkers[id]);
    });
    this.waypointMarkers = {};

    // Add new markers
    waypoints.forEach(wp => this.addWaypointMarker(wp));

    // Update routing if we have 2+ waypoints
    if (waypoints.length >= 2) {
      this.updateRoute(waypoints);
    } else {
      this.clearRoute();
    }
  },

  /**
   * Update route between waypoints
   */
  updateRoute(waypoints) {
    // Clear existing route
    this.clearRoute();

    if (waypoints.length < 2) return;

    // Create waypoints for routing
    const routeWaypoints = waypoints
      .sort((a, b) => a.order - b.order)
      .map(wp => L.latLng(wp.lat, wp.lng));

    // Create routing control
    this.routingControl = L.Routing.control({
      waypoints: routeWaypoints,
      routeWhileDragging: true,
      showAlternatives: false,
      addWaypoints: true, // Allow adding waypoints by clicking on route
      fitSelectedRoutes: false,
      lineOptions: {
        styles: [
          { color: '#e94560', opacity: 0.8, weight: 6 },
          { color: '#ff6b6b', opacity: 0.5, weight: 10 }
        ]
      },
      createMarker: () => null, // We manage our own markers
      show: false // Hide the directions panel
    }).addTo(this.map);

    // Handle route changes from dragging
    this.routingControl.on('routesfound', (e) => {
      const route = e.routes[0];
      if (route) {
        App.saveRouteData({
          distance: route.summary.totalDistance,
          time: route.summary.totalTime,
          coordinates: route.coordinates
        });
      }
    });
  },

  /**
   * Clear route from map
   */
  clearRoute() {
    if (this.routingControl) {
      this.map.removeControl(this.routingControl);
      this.routingControl = null;
    }
  },

  /**
   * Fit map to show all waypoints
   */
  fitToWaypoints(waypoints) {
    if (waypoints.length === 0) return;

    const bounds = L.latLngBounds(
      waypoints.map(wp => [wp.lat, wp.lng])
    );
    
    this.map.fitBounds(bounds, { padding: [50, 50] });
  },

  /**
   * Center on specific waypoint
   */
  centerOnWaypoint(waypoint) {
    this.map.setView([waypoint.lat, waypoint.lng], 15);
    
    // Open popup
    if (this.waypointMarkers[waypoint.id]) {
      this.waypointMarkers[waypoint.id].openPopup();
    }
  },

  /**
   * Clear all markers and routes
   */
  clear() {
    this.clearRoute();
    Object.keys(this.waypointMarkers).forEach(id => {
      this.map.removeLayer(this.waypointMarkers[id]);
    });
    this.waypointMarkers = {};
  }
};

// Make available globally
window.MapManager = MapManager;
