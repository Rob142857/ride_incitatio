/**
 * Main App module - orchestrates all components
 */
const App = {
  currentTrip: null,
  currentUser: null,
  isOnline: true,
  useCloud: false, // Will be true when deployed to Cloudflare
  isSharedView: false,
  isRiding: false,
  rideVisitedWaypoints: null,
  rideRerouting: false,
  offRouteCounter: 0,
  lastRerouteAt: 0,
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
    this.bindEvents();
    this.bindSessionRefresh();
    
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
        return true;
      }
      // No session present (401)
      this.currentUser = null;
      this.useCloud = false;
      return false;
    } catch (error) {
      console.error('Auth check failed', error);
      UI.showToast('Auth check failed. Working offline until re-auth.', 'info');
      // Preserve existing useCloud flag so we can retry when online/focused
      return false;
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
    const coverFileInput = document.getElementById('tripDetailCoverFile');
    const coverFileBtn = document.getElementById('tripDetailCoverFileBtn');
    const coverFileName = document.getElementById('tripDetailCoverFileName');

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveTripDetails();
      });
    }

    if (coverFileBtn && coverFileInput) {
      coverFileBtn.addEventListener('click', () => coverFileInput.click());
      coverFileInput.addEventListener('change', () => {
        coverFileName.textContent = coverFileInput.files?.[0]?.name || '';
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

  bindJournalAttachmentPicker() {
    const fileInput = document.getElementById('journalAttachmentFile');
    const fileBtn = document.getElementById('journalAttachmentBtn');
    const fileName = document.getElementById('journalAttachmentFileName');
    if (!fileInput || !fileBtn || !fileName) return;

    fileBtn.addEventListener('click', () => {
      fileInput.value = '';
      fileInput.dataset.entryId = document.getElementById('noteEntryId')?.value || '';
      fileName.textContent = '';
      fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
      const entryId = fileInput.dataset.entryId;
      const file = fileInput.files?.[0];
      fileName.textContent = file ? file.name : '';
      if (!file || !entryId) return;
      await this.uploadJournalAttachment(entryId, file);
    });
  },

  startEditJournalEntry(entryId) {
    if (!this.currentTrip) return;
    const entry = (this.currentTrip.journal || []).find((e) => e.id === entryId);
    if (!entry) return;
    const titleEl = document.getElementById('noteTitle');
    const contentEl = document.getElementById('noteContent');
    const privateEl = document.getElementById('notePrivate');
    const tagsEl = document.getElementById('noteTags');
    const idEl = document.getElementById('noteEntryId');
    if (titleEl) titleEl.value = entry.title || '';
    if (contentEl) contentEl.value = entry.content || '';
    if (privateEl) privateEl.checked = !!entry.isPrivate;
    if (tagsEl) tagsEl.value = (entry.tags || []).join(', ');
    if (idEl) idEl.value = entry.id;
    UI.openModal('noteModal');
  },

  pickJournalAttachment(entryId) {
    const fileInput = document.getElementById('journalAttachmentFile');
    const fileName = document.getElementById('journalAttachmentFileName');
    if (!fileInput) return;
    fileInput.dataset.entryId = entryId;
    fileInput.value = '';
    if (fileName) fileName.textContent = '';
    fileInput.click();
  },

  bindSessionRefresh() {
    // Re-verify session and refresh trips when returning to the app or regaining connectivity
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) return;
      const hadUser = !!this.currentUser;
      const authed = await this.checkAuth();
      if (authed || hadUser) {
        this.refreshTripsList();
      }
    });

    window.addEventListener('online', async () => {
      const authed = await this.checkAuth();
      if (authed) {
        this.refreshTripsList();
      }
    });
  },

  bindEvents() {
    this.bindJournalAttachmentPicker();
  },

  formatDistance(meters) {
    if (!meters && meters !== 0) return '—';
    if (meters >= 1000) return (meters / 1000).toFixed(1) + ' km';
    return Math.round(meters) + ' m';
  },

  formatDuration(seconds) {
    if (!seconds && seconds !== 0) return '—';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes} min`;
  },

  /**
   * Placeholder: tile prefetch could be added here (e.g., fetch surrounding tiles by bounding box)
   */
  prefetchTiles() {
    if (this.currentTrip?.route?.coordinates) {
      MapManager.prefetchTiles(this.currentTrip.route.coordinates);
    }
  },

  /**
   * Enter riding mode (stub for upcoming riding view)
   */
  enterRideMode() {
    if (!this.currentTrip) {
      UI.showToast('No trip loaded', 'error');
      return;
    }
    if (!this.currentTrip.route || !this.currentTrip.route.coordinates) {
      UI.showToast('Add a route first to start riding', 'error');
      return;
    }

    this.isRiding = true;
    this.rideVisitedWaypoints = new Set();
    this.rideRerouting = false;
    this.offRouteCounter = 0;
    this.lastRerouteAt = 0;
    document.getElementById('rideOverlay')?.classList.remove('hidden');
    document.body.classList.add('ride-mode');

    // Populate overlay
    document.getElementById('rideTripName').textContent = this.currentTrip.name || 'Ride';
    document.getElementById('rideStops').textContent = (this.currentTrip.waypoints?.length ?? 0).toString();
    document.getElementById('rideDistanceRemaining').textContent = this.currentTrip.route?.distance ? this.formatDistance(this.currentTrip.route.distance) : '—';
    document.getElementById('rideEta').textContent = this.currentTrip.route?.duration ? this.formatDuration(this.currentTrip.route.duration) : '—';
    document.getElementById('rideNextInstruction').textContent = 'Follow the route';
    document.getElementById('rideNextMeta').textContent = 'Waiting for GPS...';
    this.precomputeRouteMetrics();
    this.prefetchTiles();

    MapManager.startRide((pos) => this.onRidePosition(pos));
  },

  exitRideMode() {
    this.isRiding = false;
    this.rideVisitedWaypoints = null;
    this.rideRerouting = false;
    this.offRouteCounter = 0;
    document.getElementById('rideOverlay')?.classList.add('hidden');
    document.body.classList.remove('ride-mode');
    MapManager.stopRide();
  },

  precomputeRouteMetrics() {
    if (!this.currentTrip?.route?.coordinates) return;
    const coords = this.currentTrip.route.coordinates;
    const cumulative = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      total += this.haversine(coords[i - 1], coords[i]);
      cumulative.push(total);
    }
    this.currentTrip.route._cumulative = cumulative;
    this.currentTrip.route._total = total;
  },

  haversine(a, b) {
    const toRad = (v) => v * Math.PI / 180;
    const R = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(h));
  },

  markVisitedWaypoints(position) {
    if (!this.currentTrip?.waypoints) return;
    const threshold = 40; // meters
    if (!this.rideVisitedWaypoints) this.rideVisitedWaypoints = new Set();

    this.currentTrip.waypoints.forEach((wp) => {
      if (this.rideVisitedWaypoints.has(wp.id)) return;
      const d = this.haversine(wp, position);
      if (d <= threshold) {
        this.rideVisitedWaypoints.add(wp.id);
      }
    });
  },

  getRemainingWaypoints() {
    if (!this.currentTrip?.waypoints) return [];
    if (!this.rideVisitedWaypoints) this.rideVisitedWaypoints = new Set();
    return [...this.currentTrip.waypoints]
      .filter((wp) => !this.rideVisitedWaypoints.has(wp.id))
      .sort((a, b) => a.order - b.order);
  },

  onRidePosition(pos) {
    if (!this.isRiding || !this.currentTrip?.route?.coordinates || !this.currentTrip.route._cumulative) return;
    const coords = this.currentTrip.route.coordinates;
    const cumulative = this.currentTrip.route._cumulative;
    const total = this.currentTrip.route._total || cumulative[cumulative.length - 1] || 0;

    this.markVisitedWaypoints(pos);

    const remainingWaypoints = this.getRemainingWaypoints();
    const stopsEl = document.getElementById('rideStops');
    if (stopsEl) {
      stopsEl.textContent = remainingWaypoints.length.toString();
    }

    // Find nearest segment point
    let nearestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = this.haversine(coords[i], pos);
      if (d < bestDist) {
        bestDist = d;
        nearestIdx = i;
      }
    }

    const baseThreshold = 50; // meters for typical GPS noise
    const dynamicThreshold = Math.max(baseThreshold, (pos.accuracy || 30) * 1.6);
    const offRouteThreshold = dynamicThreshold;
    const now = Date.now();
    if (bestDist > offRouteThreshold) {
      this.offRouteCounter = (this.offRouteCounter || 0) + 1;
    } else {
      this.offRouteCounter = 0;
    }

    const requiredSamples = 4; // demand 4 consecutive off-route samples to avoid noise
    const canReroute = bestDist > offRouteThreshold && this.offRouteCounter >= requiredSamples && !this.rideRerouting && (now - (this.lastRerouteAt || 0) > 45000);
    if (canReroute) {
      this.rideRerouting = true;
      this.lastRerouteAt = now;
      UI.showToast('Off route. Rerouting...', 'info');
      MapManager.rerouteFromPosition(pos, remainingWaypoints);
    }

    const remaining = Math.max(0, total - cumulative[nearestIdx]);
    document.getElementById('rideDistanceRemaining').textContent = this.formatDistance(remaining);

    // Next instruction: first step whose index >= nearestIdx
    const steps = this.currentTrip.route.steps || [];
    const nextStep = steps.find((s) => s.index >= nearestIdx) || steps[steps.length - 1];
    if (nextStep) {
      document.getElementById('rideNextInstruction').textContent = nextStep.text || 'Continue';
      document.getElementById('rideNextMeta').textContent = `${this.formatDistance(nextStep.distance || 0)} ahead`;
    } else {
      document.getElementById('rideNextInstruction').textContent = 'Finish';
      document.getElementById('rideNextMeta').textContent = 'Approaching destination';
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
    
    // Clear local trips/cache on logout
    Storage.clearTrips();
    this.currentTrip = null;
    MapManager.clear();
    UI.renderWaypoints([]);
    UI.renderJournal([]);
    UI.updateTripTitle('');
    UI.updateTripStats(null);
    UI.renderTrips([], null);

    UI.showToast('Signed out', 'success');
    
    // Do not auto-load local trips after logout
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
      // When not authenticated, skip creating/loading local trips; wait for login
      UI.renderTrips([], null);
      UI.renderWaypoints([]);
      UI.renderJournal([]);
      UI.updateTripTitle('');
      UI.updateTripStats(null);
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
    const coverInput = document.getElementById('tripDetailCover');
    if (coverInput) coverInput.value = trip.cover_image_url || '';
    const coverFileName = document.getElementById('tripDetailCoverFileName');
    if (coverFileName) coverFileName.textContent = '';
    document.getElementById('tripDetailPublic').checked = !!trip.is_public;
    const linkInput = document.getElementById('tripDetailLink');
    const link = trip.short_url || (trip.short_code ? `${window.location.origin}/${trip.short_code}` : '');
    linkInput.value = link || '';
    document.getElementById('tripDetailsModal').dataset.tripId = trip.id;
  },

  async saveTripDetails() {
    const name = document.getElementById('tripDetailName').value.trim();
    const description = document.getElementById('tripDetailDescription').value.trim();
    const coverInput = document.getElementById('tripDetailCover');
    const coverFileInput = document.getElementById('tripDetailCoverFile');
    const coverFile = coverFileInput?.files?.[0];
    let coverImageUrl = coverInput?.value?.trim() || '';
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
      if (coverFile && (!this.useCloud || !this.currentUser)) {
        UI.showToast('Sign in to upload a cover image', 'error');
        return;
      }

      if (coverFile) {
        UI.showToast('Uploading cover image...', 'info');
        const attachment = await API.attachments.upload(tripId, coverFile, { is_cover: true });
        coverImageUrl = attachment.url;
        if (coverInput) coverInput.value = coverImageUrl;
      }
      if (this.useCloud && this.currentUser) {
        await API.trips.update(tripId, { name, description, is_public: isPublic, cover_image_url: coverImageUrl || null });

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
        trip.cover_image_url = coverImageUrl;
        Storage.saveTrip(trip);
        updatedTrip = trip;
      }

      this.loadTripDataIfCurrent(updatedTrip);
      this.refreshTripsList();
      this.fillTripDetailsForm(updatedTrip);
      if (coverFileInput) {
        coverFileInput.value = '';
        const coverFileName = document.getElementById('tripDetailCoverFileName');
        if (coverFileName) coverFileName.textContent = '';
      }
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
    // Normalize share settings for downstream sharing UI
    Trip.ensureShareSettings(trip);
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
        trip.share_id = sharedData.share_id;
        trip.short_code = sharedData.short_code;
        trip.is_public = sharedData.is_public;
        
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
          route: this.currentTrip.route,
          cover_image_url: this.currentTrip.cover_image_url
        });
      } catch (error) {
        console.error('Failed to save to cloud:', error);
        UI.showToast('Save failed. Not saved to cloud.', 'error');
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
        UI.showToast('Could not add waypoint (not saved)', 'error');
        return null;
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
        UI.showToast('Move failed. Not saved to cloud.', 'error');
        return;
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
        UI.showToast('Reorder failed. Not saved to cloud.', 'error');
        return;
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
        UI.showToast('Note not saved to cloud.', 'error');
        return null;
      }
    } else {
      entry = Trip.addJournalEntry(this.currentTrip, data);
      Storage.saveTrip(this.currentTrip);
    }
    
    UI.renderJournal(this.currentTrip.journal);
    
    return entry;
  },

  async updateJournalEntry(entryId, data) {
    if (!this.currentTrip) return;
    let updated;
    if (this.useCloud && this.currentUser) {
      try {
        updated = await API.journal.update(this.currentTrip.id, entryId, {
          title: data.title,
          content: data.content,
          is_private: data.isPrivate,
          tags: data.tags
        });
      } catch (error) {
        console.error('Failed to update journal entry:', error);
        UI.showToast('Note not updated in cloud.', 'error');
        return null;
      }
    } else {
      updated = Trip.updateJournalEntry(this.currentTrip, entryId, {
        title: data.title,
        content: data.content,
        isPrivate: data.isPrivate,
        tags: data.tags
      });
      Storage.saveTrip(this.currentTrip);
    }

    // Sync local array
    if (updated) {
      const idx = this.currentTrip.journal.findIndex((e) => e.id === entryId);
      if (idx >= 0) this.currentTrip.journal[idx] = updated;
    }

    UI.renderJournal(this.currentTrip.journal);
    return updated;
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
        UI.showToast('Delete failed on cloud.', 'error');
        return;
      }
    }
    
    Trip.removeJournalEntry(this.currentTrip, entryId);
    this.saveCurrentTrip();
    
    UI.renderJournal(this.currentTrip.journal);
    UI.showToast('Note deleted', 'success');
  },

  async uploadJournalAttachment(entryId, file) {
    if (!this.currentTrip) return;
    if (!this.useCloud || !this.currentUser) {
      UI.showToast('Sign in to upload attachments', 'error');
      return;
    }
    try {
      UI.showToast('Uploading attachment...', 'info');
      await API.attachments.upload(this.currentTrip.id, file, { journal_entry_id: entryId });
      UI.showToast('Attachment uploaded', 'success');
    } catch (err) {
      console.error('Attachment upload failed', err);
      UI.showToast('Attachment upload failed', 'error');
    }
  },

  /**
   * Save route data from routing control
   */
  saveRouteData(routeData) {
    if (!this.currentTrip) return;
    
    this.currentTrip.route = routeData;
    this.precomputeRouteMetrics();
    this.prefetchTiles();
    this.rideRerouting = false;
    this.offRouteCounter = 0;
    
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
