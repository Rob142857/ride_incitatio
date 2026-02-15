/**
 * App Core — state, init, shared utilities
 * Controllers (auth, trip, waypoint, journal, ride) extend this object via Object.assign.
 */
const App = {
  currentTrip: null,
  currentUser: null,
  isOnline: true,
  useCloud: false,
  isSharedView: false,
  isRiding: false,
  isRefreshing: false,
  rideVisitedWaypoints: null,
  rideRerouting: false,
  offRouteCounter: 0,
  lastRerouteAt: 0,
  loginPromptShown: false,
  tripDetailId: null,
  tripListCache: [],
  tripDataCache: {},
  waypointSaveToastAt: 0,
  isReorderingWaypoints: false,
  tripWriteClock: {},

  async init() {
    console.log('Ride Trip Planner initializing...');

    this.isOnline = navigator.onLine;
    window.addEventListener('online', () => this.handleOnlineChange(true));
    window.addEventListener('offline', () => this.handleOnlineChange(false));

    UI.init();
    MapManager.init();

    const urlParams = new URLSearchParams(window.location.search);
    const sharedTripId = urlParams.get('trip');
    const isEmbed = urlParams.get('embed') === 'true';
    const authError = urlParams.get('error');
    const authErrorDesc = urlParams.get('error_description');
    this.isSharedView = !!sharedTripId;

    const landingSeen = (() => {
      try { return localStorage.getItem('ride_landing_seen') === '1'; } catch (_) { return true; }
    })();
    if (!landingSeen && !this.isSharedView && !isEmbed) {
      UI.showLandingGate();
    }

    await this.checkAuth();
    Storage.clearTrips();

    window.addEventListener('ride:auth-expired', () => this.handleAuthExpired());
    window.addEventListener('ride:connection-lost', (e) => this.handleConnectionLost(e?.detail));

    this.configureLoginLinks();
    if (!this.isSharedView) this.showLoginPromptIfNeeded();

    this.bindUserButton();
    this.bindTripDetails();
    this.bindEvents();
    this.bindSessionRefresh();

    if (authError) this.handleAuthErrorFromUrl(authError, authErrorDesc);

    if (sharedTripId) {
      await this.loadSharedTrip(sharedTripId, isEmbed);
    } else {
      await this.loadInitialTrip();
    }

    this.refreshTripsList();
    console.log('Ride Trip Planner initialized');
  },

  /* --- Shared utilities --- */

  handleOnlineChange(online) {
    this.isOnline = online;
    UI.showToast(online ? 'Back online' : 'You are offline', online ? 'success' : 'info');
  },

  ensureEditable(action = 'make changes') {
    if (!this.currentUser || !this.useCloud) {
      UI.showToast(`Sign in to ${action}.`, 'error');
      UI.showAuthGate('Signed out');
      return false;
    }
    if (!this.isOnline) {
      UI.showToast('Offline. Editing is disabled until you reconnect.', 'error');
      return false;
    }
    return true;
  },

  normalizeTrip(trip) {
    if (!trip) return trip;
    const normalized = { ...trip };
    // Ensure camelCase aliases exist (API normalizer handles most, but locally-created trips may not have them)
    if (!normalized.createdAt && normalized.created_at) normalized.createdAt = normalized.created_at;
    if (!normalized.updatedAt && normalized.updated_at) normalized.updatedAt = normalized.updated_at;
    if (normalized.waypoints) normalized.waypoints = Trip.normalizeWaypointOrder(normalized.waypoints);
    if (normalized.route) {
      const duration = normalized.route.duration ?? normalized.route.time ?? null;
      normalized.route = {
        ...normalized.route, duration, time: duration,
        coordinates: normalized.route.coordinates || []
      };
    }
    // Ensure cover focus defaults
    if (!Number.isFinite(normalized.coverFocusX)) normalized.coverFocusX = normalized.cover_focus_x ?? 50;
    if (!Number.isFinite(normalized.coverFocusY)) normalized.coverFocusY = normalized.cover_focus_y ?? 50;
    normalized.cover_focus_x = normalized.coverFocusX;
    normalized.cover_focus_y = normalized.coverFocusY;
    // Ensure coverImageUrl alias
    if (!normalized.coverImageUrl) normalized.coverImageUrl = normalized.cover_image_url || '';
    normalized.cover_image_url = normalized.coverImageUrl;
    return normalized;
  },

  getTripSortTimestamp(trip) {
    const ts = trip?.updatedAt || trip?.createdAt;
    return ts ? new Date(ts).getTime() : 0;
  },

  formatDistance(m) { return RideUtils.formatDistance(m); },
  formatDuration(s) { return RideUtils.formatDuration(s); },

  /** Clear all trip-related UI (used on logout / auth fail) */
  _clearTripUI() {
    this.currentTrip = null;
    this.tripListCache = [];
    MapManager.clear();
    UI.renderTrips([], null);
    UI.renderWaypoints([]);
    UI.renderJournal([]);
    UI.updateTripTitle('');
    UI.updateTripStats(null);
  },

  /* --- Event binding --- */

  bindEvents() {
    this.bindJournalAttachmentPicker();
    this.bindWaypointDetails();
    this.bindRideControls();
  },

  bindTripDetails() {
    const form = document.getElementById('tripDetailsForm');
    const copyBtn = document.getElementById('tripDetailCopy');
    const coverFileInput = document.getElementById('tripDetailCoverFile');
    const coverFileBtn = document.getElementById('tripDetailCoverFileBtn');
    const coverFileName = document.getElementById('tripDetailCoverFileName');
    const coverInput = document.getElementById('tripDetailCover');
    const focusXInput = document.getElementById('tripDetailCoverFocusX');
    const focusYInput = document.getElementById('tripDetailCoverFocusY');

    if (form) form.addEventListener('submit', e => { e.preventDefault(); this.saveTripDetails(); });
    if (coverFileBtn && coverFileInput) {
      coverFileBtn.addEventListener('click', () => coverFileInput.click());
      coverFileInput.addEventListener('change', () => {
        const file = coverFileInput.files?.[0];
        if (coverFileName) coverFileName.textContent = file?.name || '';
        // Show local preview immediately via blob URL
        if (file && file.type.startsWith('image/')) {
          if (this._coverBlobUrl) URL.revokeObjectURL(this._coverBlobUrl);
          this._coverBlobUrl = URL.createObjectURL(file);
          this.updateCoverFocusUI();
        }
      });
    }
    if (coverInput) coverInput.addEventListener('input', () => {
      // Clear blob preview when user types a URL manually
      if (this._coverBlobUrl) { URL.revokeObjectURL(this._coverBlobUrl); this._coverBlobUrl = null; }
      this.updateCoverFocusUI();
    });
    if (focusXInput) focusXInput.addEventListener('input', () => this.updateCoverFocusUI());
    if (focusYInput) focusYInput.addEventListener('input', () => this.updateCoverFocusUI());

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const input = document.getElementById('tripDetailLink');
        if (!input?.value) { UI.showToast('No link to copy yet', 'info'); return; }
        try {
          await navigator.clipboard.writeText(input.value);
          UI.showToast('Link copied', 'success');
        } catch (err) { console.error(err); UI.showToast('Copy failed', 'error'); }
      });
    }
    this.updateCoverFocusUI();
  },

  updateCoverFocusUI() {
    const coverInput = document.getElementById('tripDetailCover');
    const preview = document.getElementById('tripDetailCoverPreview');
    const focusXInput = document.getElementById('tripDetailCoverFocusX');
    const focusYInput = document.getElementById('tripDetailCoverFocusY');
    const focusXValue = document.getElementById('tripDetailCoverFocusXValue');
    const focusYValue = document.getElementById('tripDetailCoverFocusYValue');
    const xRaw = Number(focusXInput?.value);
    const yRaw = Number(focusYInput?.value);
    const x = Number.isFinite(xRaw) ? xRaw : 50;
    const y = Number.isFinite(yRaw) ? yRaw : 50;
    if (focusXValue) focusXValue.textContent = `${x}%`;
    if (focusYValue) focusYValue.textContent = `${y}%`;
    if (preview) {
      // Prefer local blob preview (file just picked), then fall back to URL input
      const imageUrl = this._coverBlobUrl || coverInput?.value?.trim() || '';
      preview.style.backgroundImage = imageUrl ? `url('${imageUrl}')` : 'none';
      preview.style.backgroundPosition = `${x}% ${y}%`;
      preview.style.backgroundSize = 'cover';
    }
  },

  /* --- Import & share --- */

  async importTrip() {
    try {
      const trip = await Share.importFromFile();
      if (this.useCloud && this.currentUser) {
        const cloudTrip = await API.trips.create({ name: trip.name });
        for (const wp of trip.waypoints) await API.waypoints.add(cloudTrip.id, wp);
        for (const entry of trip.journal) await API.journal.add(cloudTrip.id, entry);
        const fullTrip = await API.trips.get(cloudTrip.id);
        this.loadTripData(fullTrip);
      } else {
        UI.showToast('Login to import trips to your account.', 'error');
        return;
      }
      this.refreshTripsList();
      UI.showToast(`Imported: ${trip.name}`, 'success');
    } catch (err) {
      console.error('Import error:', err);
      UI.showToast('Failed to import trip', 'error');
    }
  },

  async loadSharedTrip(shareId, isEmbed) {
    try {
      let sharedData;
      if (this.useCloud) {
        sharedData = await API.shared.get(shareId);
      } else {
        sharedData = Share.loadSharedTrip(shareId);
      }
      if (sharedData) {
        const trip = Trip.create(sharedData.name);
        trip.waypoints = Trip.normalizeWaypointOrder(sharedData.waypoints || []);
        trip.journal = (sharedData.journal || []).map(e => ({
          ...e,
          isPrivate: !!(e.is_private ?? e.isPrivate),
          createdAt: e.created_at ?? e.createdAt,
          updatedAt: e.updated_at ?? e.updatedAt,
          tags: Array.isArray(e.tags) ? e.tags : [],
          attachments: e.attachments || [],
        }));
        trip.shareId = sharedData.share_id ?? sharedData.shareId;
        trip.share_id = trip.shareId;
        trip.shortCode = sharedData.short_code ?? sharedData.shortCode;
        trip.short_code = trip.shortCode;
        trip.isPublic = !!(sharedData.is_public ?? sharedData.isPublic);
        trip.is_public = trip.isPublic ? 1 : 0;
        trip.coverImageUrl = sharedData.cover_image_url || sharedData.coverImageUrl || sharedData.cover_image || '';
        trip.cover_image_url = trip.coverImageUrl;
        trip.coverFocusX = Number.isFinite(sharedData.cover_focus_x) ? sharedData.cover_focus_x : (sharedData.coverFocusX ?? 50);
        trip.cover_focus_x = trip.coverFocusX;
        trip.coverFocusY = Number.isFinite(sharedData.cover_focus_y) ? sharedData.cover_focus_y : (sharedData.coverFocusY ?? 50);
        trip.cover_focus_y = trip.coverFocusY;
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
  }
};

// Initialize app when DOM is ready (all controller scripts loaded by then)
document.addEventListener('DOMContentLoaded', () => App.init());
window.App = App;
