/**
 * Main App module - orchestrates all components
 */
const App = {
  currentTrip: null,
  currentUser: null,
  isOnline: true,
  useCloud: false, // Will be true when deployed to Cloudflare
  isSharedView: false,
  loginPromptShown: false,
  tripDetailId: null,

  /**
   * Initialize the application
   */
  async init() {
    console.log('Ride Trip Planner initializing...');
    
    // Check online status
    this.isOnline = navigator.onLine;
    window.addEventListener('online', () => this.handleOnlineChange(true));
    window.addEventListener('offline', () => this.handleOnlineChange(false));
    
    // Initialize modules
    UI.init();
    MapManager.init();
    
    // Check for shared trip in URL
    const urlParams = new URLSearchParams(window.location.search);
    const sharedTripId = urlParams.get('trip');
    const isEmbed = urlParams.get('embed') === 'true';
    const authError = urlParams.get('error');
    this.isSharedView = !!sharedTripId;
    
    // Try to authenticate if cloud is available
    await this.checkAuth();
    this.configureLoginLinks();
    if (!this.isSharedView) {
      this.showLoginPromptIfNeeded();
    }
    
    // Bind user button
    this.bindUserButton();
    this.bindTripDetails();
    
    if (authError) {
      UI.showToast('Login failed. Please try again.', 'error');
      // Clear the error from URL
      window.history.replaceState({}, '', window.location.pathname);
    }
    
    if (sharedTripId) {
      await this.loadSharedTrip(sharedTripId, isEmbed);
    } else {
      // Load existing trip or create new one
      await this.loadInitialTrip();
    }

    // Render trips list
    this.refreshTripsList();
    
    console.log('Ride Trip Planner initialized');
  },

  /**
   * Check authentication status
   */
  async checkAuth() {
    try {
      const user = await API.auth.getUser();
      if (user) {
        this.currentUser = user;
        this.useCloud = true;
        this.updateUserUI();
        UI.closeModal('loginModal');
      }
    } catch (error) {
      // Not authenticated or API not available - use local storage
      console.log('Using local storage mode');
      this.useCloud = false;
    }
  },

  configureLoginLinks() {
    const returnTo = window.location.href;
    document.querySelectorAll('[data-login-provider]').forEach((el) => {
      const provider = el.dataset.loginProvider;
      el.href = API.auth.loginUrl(provider, returnTo);
    });
  },

  /**
   * Prompt login on landing if not authenticated
   */
  showLoginPromptIfNeeded() {
    if (!this.currentUser && !this.loginPromptShown) {
      UI.openModal('loginModal');
      this.loginPromptShown = true;
    }
  },

  /**
   * Bind user button events
   */
  bindUserButton() {
    const userBtn = document.getElementById('userBtn');
    
    userBtn.addEventListener('click', () => {
      if (this.currentUser) {
        this.showUserDropdown();
      } else {
        UI.openModal('loginModal');
      }
    });
  },

  /**
   * Bind trip details modal controls
   */
  bindTripDetails() {
    const form = document.getElementById('tripDetailsForm');
    const copyBtn = document.getElementById('tripDetailCopy');

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveTripDetails();
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const input = document.getElementById('tripDetailLink');
        if (!input?.value) {
          UI.showToast('No link to copy yet', 'info');
          return;
        }
        try {
          await navigator.clipboard.writeText(input.value);
          UI.showToast('Link copied', 'success');
        } catch (err) {
          console.error(err);
          UI.showToast('Copy failed', 'error');
        }
      });
    }

  },

  /**
   * Update UI for logged in user
   */
  updateUserUI() {
    const userBtn = document.getElementById('userBtn');
    const userIcon = document.getElementById('userIcon');
    const userAvatar = document.getElementById('userAvatar');
    
    if (this.currentUser) {
      userBtn.classList.add('logged-in');
      if (this.currentUser.avatar_url) {
        userAvatar.src = this.currentUser.avatar_url;
        userAvatar.classList.remove('hidden');
      }
    } else {
      userBtn.classList.remove('logged-in');
      userAvatar.classList.add('hidden');
    }
  },

  /**
   * Show user dropdown menu
   */
  showUserDropdown() {
    // Remove existing dropdown if any
    const existing = document.querySelector('.user-dropdown');
    if (existing) {
      existing.remove();
      return;
    }
    
    const dropdown = document.createElement('div');
    dropdown.className = 'user-dropdown';
    dropdown.innerHTML = `
      <div class="user-dropdown-header">
        <div class="user-dropdown-name">${UI.escapeHtml(this.currentUser.name)}</div>
        <div class="user-dropdown-email">${UI.escapeHtml(this.currentUser.email)}</div>
      </div>
      <div class="user-dropdown-actions">
        <button id="logoutBtn" class="danger">Sign Out</button>
      </div>
    `;
    
    document.getElementById('userBtn').parentElement.appendChild(dropdown);
    
    dropdown.querySelector('#logoutBtn').addEventListener('click', () => this.logout());
    
    // Close on click outside
    setTimeout(() => {
      document.addEventListener('click', function closeDropdown(e) {
        if (!dropdown.contains(e.target) && e.target.id !== 'userBtn') {
          dropdown.remove();
          document.removeEventListener('click', closeDropdown);
        }
      });
    }, 10);
  },

  /**
   * Logout user
   */
  async logout() {
    try {
      await API.auth.logout();
    } catch (e) {}
    
    this.currentUser = null;
    this.useCloud = false;
    this.updateUserUI();
    
    // Remove dropdown
    const dropdown = document.querySelector('.user-dropdown');
    if (dropdown) dropdown.remove();
    
    UI.showToast('Signed out', 'success');
    
    // Reload to show local data
    this.loadInitialTrip();
    this.refreshTripsList();
  },

  /**
   * Handle online/offline changes
   */
  handleOnlineChange(online) {
    this.isOnline = online;
    UI.showToast(online ? 'Back online' : 'You are offline', online ? 'success' : 'info');
  },

  /**
   * Load initial trip (from cloud or local storage)
   */
  async loadInitialTrip() {
    if (this.useCloud && this.currentUser) {
      // Load from cloud
      try {
        let trips = await API.trips.list();

        // If cloud is empty but local has data, migrate once
        if (trips.length === 0) {
          const migrated = await this.migrateLocalTripsToCloud();
          if (migrated > 0) {
            trips = await API.trips.list();
          }
        }

        if (trips.length > 0) {
          const trip = await API.trips.get(trips[0].id);
          this.loadTripData(trip);
        } else {
          this.createNewTrip();
        }
      } catch (error) {
        console.error('Failed to load cloud trips:', error);
        this.fallbackToLocal();
      }
    } else {
      this.fallbackToLocal();
    }
  },

  /**
   * Fallback to local storage
   */
  fallbackToLocal() {
    const currentTripId = Storage.getCurrentTripId();
    if (currentTripId) {
      const trip = Storage.getTrip(currentTripId);
      if (trip) {
        this.loadTripData(trip);
        return;
      }
    }
    this.createNewTrip();
  },

  /**
   * One-time migration: if user just logged in and cloud is empty but local has trips,
   * push local trips to the cloud account.
   */
  async migrateLocalTripsToCloud() {
    const localTrips = Storage.getTrips();
    if (!localTrips.length) return 0;

    let cloudTrips = [];
    try {
      cloudTrips = await API.trips.list();
    } catch (err) {
      console.error('Cannot read cloud trips during migration', err);
      return 0;
    }

    if (cloudTrips.length > 0) return 0; // Already has cloud data; skip to avoid duplicates

    let migrated = 0;
    for (const local of localTrips) {
      try {
        const cloudTrip = await API.trips.create({
          name: local.name || 'Trip',
          description: local.description || ''
        });

        // Waypoints
        const waypoints = Array.isArray(local.waypoints) ? local.waypoints : [];
        for (const wp of waypoints) {
          await API.waypoints.add(cloudTrip.id, {
            name: wp.name,
            address: wp.address,
            lat: wp.lat,
            lng: wp.lng,
            type: wp.type,
            notes: wp.notes,
            sort_order: wp.order ?? wp.sort_order ?? 0
          });
        }

        // Journal entries
        const journal = Array.isArray(local.journal) ? local.journal : [];
        for (const entry of journal) {
          await API.journal.add(cloudTrip.id, {
            title: entry.title,
            content: entry.content,
            is_private: entry.isPrivate,
            tags: entry.tags,
            location: entry.location,
            waypoint_id: entry.waypointId || null
          });
        }

        migrated++;
      } catch (err) {
        console.error('Failed to migrate a local trip', err);
      }
    }

    if (migrated > 0) {
      UI.showToast(`Synced ${migrated} local trip(s) to your account`, 'success');
    }

    return migrated;
  },

  /**
   * Create a new trip
   */
  async createNewTrip(name = 'New Trip') {
    if (this.useCloud && this.currentUser) {
      try {
        const trip = await API.trips.create({ name });
        const fullTrip = await API.trips.get(trip.id);
        this.currentTrip = fullTrip;
        this.loadTripData(fullTrip);
        this.refreshTripsList();
        UI.showToast('New trip created', 'success');
        return;
      } catch (error) {
        console.error('Failed to create cloud trip:', error);
        UI.showToast('Session expired or offline. Using offline mode.', 'info');
        // Fall back to local mode
        this.useCloud = false;
        this.currentUser = null;
        this.updateUserUI();
      }
    }
    
    // Local fallback
    const trip = Trip.create(name);
    this.currentTrip = trip;
    Storage.saveTrip(trip);
    Storage.setCurrentTripId(trip.id);
    
    this.loadTripData(trip);
    this.refreshTripsList();
    
    UI.showToast('New trip created', 'success');
  },

  /**
   * Open trip details modal for a trip
   */
  async openTripDetails(tripId) {
    try {
      let trip;
      if (this.useCloud && this.currentUser) {
        trip = await API.trips.get(tripId);
      } else {
        trip = Storage.getTrip(tripId);
      }

      if (!trip) {
        UI.showToast('Trip not found', 'error');
        return;
      }

      this.tripDetailId = tripId;
      this.fillTripDetailsForm(trip);
      UI.openModal('tripDetailsModal');
    } catch (err) {
      console.error('Open trip details failed:', err);
      UI.showToast('Failed to load trip details', 'error');
    }
  },

  fillTripDetailsForm(trip) {
    document.getElementById('tripDetailName').value = trip.name || '';
    document.getElementById('tripDetailDescription').value = trip.description || '';
    document.getElementById('tripDetailPublic').checked = !!trip.is_public;
    const linkInput = document.getElementById('tripDetailLink');
    const link = trip.short_url || (trip.short_code ? `${window.location.origin}/${trip.short_code}` : '');
    linkInput.value = link || '';
    document.getElementById('tripDetailsModal').dataset.tripId = trip.id;
  },

  async saveTripDetails() {
    const name = document.getElementById('tripDetailName').value.trim();
    const description = document.getElementById('tripDetailDescription').value.trim();
    const isPublic = document.getElementById('tripDetailPublic').checked;
    const tripId = this.tripDetailId;

    if (!tripId) {
      UI.showToast('No trip selected', 'error');
      return;
    }

    if (!name) {
      UI.showToast('Name is required', 'error');
      return;
    }

    try {
      let updatedTrip;
      if (this.useCloud && this.currentUser) {
        await API.trips.update(tripId, { name, description, is_public: isPublic });

        // Ensure short link exists when public (fixed code per trip)
        if (isPublic) {
          const share = await API.trips.share(tripId);
          updatedTrip = await API.trips.get(tripId);
          updatedTrip.short_url = share.shareUrl;
          updatedTrip.short_code = share.shortCode;
        } else {
          updatedTrip = await API.trips.get(tripId);
        }
      } else {
        const trip = Storage.getTrip(tripId);
        if (!trip) {
          UI.showToast('Trip not found', 'error');
          return;
        }
        trip.name = name;
        trip.description = description;
        trip.is_public = isPublic;
        Storage.saveTrip(trip);
        updatedTrip = trip;
      }

      this.loadTripDataIfCurrent(updatedTrip);
      this.refreshTripsList();
      this.fillTripDetailsForm(updatedTrip);
      UI.showToast('Trip updated', 'success');
      UI.closeModal('tripDetailsModal');
    } catch (err) {
      console.error('Save trip details failed:', err);
      UI.showToast('Failed to save trip', 'error');
    }
  },

  async generateTripLink() {
    const tripId = this.tripDetailId;
    if (!tripId) return;

    // Auto-generation now handled during save when public
  },

  loadTripDataIfCurrent(trip) {
    if (this.currentTrip?.id === trip.id) {
      this.loadTripData(trip);
    }
  },

  /**
   * Load trip data into the app
   */
  loadTripData(trip) {
    this.currentTrip = trip;
    
    // Update UI
    UI.updateTripTitle(trip.name);
    UI.updateTripStats(trip);
    UI.renderWaypoints(trip.waypoints || []);
    UI.renderJournal(trip.journal || []);
    
    // Update map
    MapManager.clear();
    MapManager.updateWaypoints(trip.waypoints || []);
    
    // Fit map to waypoints if any
    if (trip.waypoints && trip.waypoints.length > 0) {
      MapManager.fitToWaypoints(trip.waypoints);
    }
  },

  /**
   * Load a trip by ID
   */
  async loadTrip(tripId) {
    if (this.useCloud && this.currentUser) {
      try {
        const trip = await API.trips.get(tripId);
        this.loadTripData(trip);
        this.refreshTripsList();
        UI.switchView('map');
        UI.showToast(`Loaded: ${trip.name}`, 'success');
        return;
      } catch (error) {
        console.error('Failed to load cloud trip:', error);
      }
    }
    
    // Local fallback
    const trip = Storage.getTrip(tripId);
    if (trip) {
      Storage.setCurrentTripId(tripId);
      this.loadTripData(trip);
      this.refreshTripsList();
      UI.switchView('map');
      UI.showToast(`Loaded: ${trip.name}`, 'success');
    }
  },

  /**
   * Load shared trip from URL
   */
  async loadSharedTrip(shareId, isEmbed) {
    try {
      let sharedData;
      
      if (this.useCloud) {
        sharedData = await API.shared.get(shareId);
      } else {
        sharedData = Share.loadSharedTrip(shareId);
      }
      
      if (sharedData) {
        // Create a temporary trip from shared data
        const trip = Trip.create(sharedData.name);
        trip.waypoints = sharedData.waypoints || [];
        trip.journal = sharedData.journal || [];
        trip.customRoutePoints = sharedData.customRoutePoints || [];
        
        this.loadTripData(trip);
        
        if (isEmbed) {
          document.getElementById('bottomNav').classList.add('hidden');
          document.getElementById('topBar').style.display = 'none';
        }
        
        UI.showToast(`Viewing: ${trip.name}`, 'info');
      } else {
        UI.showToast('Shared trip not found', 'error');
        this.loadInitialTrip();
      }
    } catch (error) {
      console.error('Failed to load shared trip:', error);
      UI.showToast('Failed to load shared trip', 'error');
      this.loadInitialTrip();
    }
  },

  /**
   * Save current trip
   */
  async saveCurrentTrip() {
    if (!this.currentTrip) return;
    
    this.currentTrip.updatedAt = new Date().toISOString();
    
    if (this.useCloud && this.currentUser) {
      try {
        await API.trips.update(this.currentTrip.id, {
          name: this.currentTrip.name,
          description: this.currentTrip.description,
          settings: this.currentTrip.settings,
          route: this.currentTrip.route
        });
      } catch (error) {
        console.error('Failed to save to cloud:', error);
        // Fallback to local
        Storage.saveTrip(this.currentTrip);
      }
    } else {
      Storage.saveTrip(this.currentTrip);
    }
  },

  /**
   * Add waypoint to current trip
   */
  async addWaypoint(data) {
    if (!this.currentTrip) return;
    
    let waypoint;
    
    if (this.useCloud && this.currentUser) {
      try {
        waypoint = await API.waypoints.add(this.currentTrip.id, data);
        if (!this.currentTrip.waypoints) this.currentTrip.waypoints = [];
        this.currentTrip.waypoints.push(waypoint);
      } catch (error) {
        console.error('Failed to add waypoint to cloud:', error);
        waypoint = Trip.addWaypoint(this.currentTrip, data);
        Storage.saveTrip(this.currentTrip);
      }
    } else {
      waypoint = Trip.addWaypoint(this.currentTrip, data);
      Storage.saveTrip(this.currentTrip);
    }
    
    // Update UI and map
    UI.renderWaypoints(this.currentTrip.waypoints);
    MapManager.addWaypointMarker(waypoint);
    
    // Update route
    if (this.currentTrip.waypoints.length >= 2) {
      MapManager.updateRoute(this.currentTrip.waypoints);
    }
    
    return waypoint;
  },

  /**
   * Update waypoint position (called from map drag)
   */
  async updateWaypointPosition(waypointId, lat, lng) {
    if (!this.currentTrip) return;
    
    if (this.useCloud && this.currentUser) {
      try {
        await API.waypoints.update(this.currentTrip.id, waypointId, { lat, lng });
      } catch (error) {
        console.error('Failed to update waypoint:', error);
      }
    }
    
    Trip.updateWaypoint(this.currentTrip, waypointId, { lat, lng });
    this.saveCurrentTrip();
    
    // Update route
    if (this.currentTrip.waypoints.length >= 2) {
      MapManager.updateRoute(this.currentTrip.waypoints);
    }
    
    UI.renderWaypoints(this.currentTrip.waypoints);
  },

  /**
   * Delete waypoint
   */
  async deleteWaypoint(waypointId) {
    if (!this.currentTrip) return;
    
    if (this.useCloud && this.currentUser) {
      try {
        await API.waypoints.delete(this.currentTrip.id, waypointId);
      } catch (error) {
        console.error('Failed to delete waypoint:', error);
      }
    }
    
    Trip.removeWaypoint(this.currentTrip, waypointId);
    this.saveCurrentTrip();
    
    MapManager.removeWaypointMarker(waypointId);
    UI.renderWaypoints(this.currentTrip.waypoints);
    
    // Update or clear route
    if (this.currentTrip.waypoints.length >= 2) {
      MapManager.updateRoute(this.currentTrip.waypoints);
    } else {
      MapManager.clearRoute();
    }
    
    UI.showToast('Waypoint deleted', 'success');
  },

  /**
   * Reorder waypoints
   */
  async reorderWaypoints(orderIds) {
    if (!this.currentTrip) return;

    // Update local order
    Trip.reorderWaypoints(this.currentTrip, orderIds);

    // Persist if online
    if (this.useCloud && this.currentUser) {
      try {
        await API.waypoints.reorder(this.currentTrip.id, orderIds);
      } catch (error) {
        console.error('Failed to reorder waypoints in cloud:', error);
      }
    }

    this.saveCurrentTrip();

    // Refresh UI and map
    UI.renderWaypoints(this.currentTrip.waypoints);
    MapManager.updateWaypoints(this.currentTrip.waypoints);
  },

  /**
   * Add journal entry
   */
  async addJournalEntry(data) {
    if (!this.currentTrip) return;
    
    let entry;
    
    if (this.useCloud && this.currentUser) {
      try {
        entry = await API.journal.add(this.currentTrip.id, {
          title: data.title,
          content: data.content,
          is_private: data.isPrivate,
          tags: data.tags
        });
        if (!this.currentTrip.journal) this.currentTrip.journal = [];
        this.currentTrip.journal.push(entry);
      } catch (error) {
        console.error('Failed to add journal entry:', error);
        entry = Trip.addJournalEntry(this.currentTrip, data);
        Storage.saveTrip(this.currentTrip);
      }
    } else {
      entry = Trip.addJournalEntry(this.currentTrip, data);
      Storage.saveTrip(this.currentTrip);
    }
    
    UI.renderJournal(this.currentTrip.journal);
    
    return entry;
  },

  /**
   * Delete journal entry
   */
  async deleteJournalEntry(entryId) {
    if (!this.currentTrip) return;
    
    if (this.useCloud && this.currentUser) {
      try {
        await API.journal.delete(this.currentTrip.id, entryId);
      } catch (error) {
        console.error('Failed to delete journal entry:', error);
      }
    }
    
    Trip.removeJournalEntry(this.currentTrip, entryId);
    this.saveCurrentTrip();
    
    UI.renderJournal(this.currentTrip.journal);
    UI.showToast('Note deleted', 'success');
  },

  /**
   * Save route data from routing control
   */
  saveRouteData(routeData) {
    if (!this.currentTrip) return;
    
    this.currentTrip.route = routeData;
    
    // Save route coordinates as custom points
    if (routeData.coordinates) {
      this.currentTrip.customRoutePoints = routeData.coordinates.map(c => ({
        lat: c.lat,
        lng: c.lng
      }));
    }
    
    UI.updateTripStats(this.currentTrip);
    this.saveCurrentTrip();
  },

  /**
   * Import trip from file
   */
  async importTrip() {
    try {
      const trip = await Share.importFromFile();
      
      if (this.useCloud && this.currentUser) {
        // Create in cloud
        const cloudTrip = await API.trips.create({ name: trip.name });
        
        // Add waypoints
        for (const wp of trip.waypoints) {
          await API.waypoints.add(cloudTrip.id, wp);
        }
        
        // Add journal entries
        for (const entry of trip.journal) {
          await API.journal.add(cloudTrip.id, entry);
        }
        
        const fullTrip = await API.trips.get(cloudTrip.id);
        this.loadTripData(fullTrip);
      } else {
        Storage.saveTrip(trip);
        Storage.setCurrentTripId(trip.id);
        this.loadTripData(trip);
      }
      
      this.refreshTripsList();
      UI.showToast(`Imported: ${trip.name}`, 'success');
    } catch (err) {
      console.error('Import error:', err);
      UI.showToast('Failed to import trip', 'error');
    }
  },

  /**
   * Refresh trips list
   */
  async refreshTripsList() {
    let trips = [];
    
    if (this.useCloud && this.currentUser) {
      try {
        trips = await API.trips.list();
      } catch (error) {
        console.error('Failed to load trips list:', error);
        trips = Storage.getTrips();
      }
    } else {
      trips = Storage.getTrips();
    }
    
    const currentId = this.currentTrip?.id;
    UI.renderTrips(trips, currentId);
  },

  /**
   * Delete trip
   */
  async deleteTrip(tripId) {
    if (this.useCloud && this.currentUser) {
      try {
        await API.trips.delete(tripId);
      } catch (error) {
        console.error('Failed to delete trip:', error);
      }
    }
    
    Storage.deleteTrip(tripId);
    
    if (this.currentTrip?.id === tripId) {
      await this.loadInitialTrip();
    }
    
    this.refreshTripsList();
    UI.showToast('Trip deleted', 'success');
  }
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());

// Make available globally
window.App = App;
