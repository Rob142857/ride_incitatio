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
  isRefreshing: false,
  rideVisitedWaypoints: null,
  rideRerouting: false,
  offRouteCounter: 0,
  lastRerouteAt: 0,
  loginPromptShown: false,
  tripDetailId: null,
  tripListCache: [],
  // In-memory cache of last known-good full trip payloads by id.
  // Used to avoid clobbering waypoint order with an older server read.
  tripDataCache: {},
  waypointSaveToastAt: 0,
  isReorderingWaypoints: false,
  // Track the last time this tab successfully mutated a given trip.
  // Used to avoid clobbering newer local state with an older server read on tab refocus.
  tripWriteClock: {},

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
    const authErrorDesc = urlParams.get('error_description');
    this.isSharedView = !!sharedTripId;

    // First-visit landing (do not show for shared/embed flows)
    const landingSeen = (() => {
      try { return localStorage.getItem('ride_landing_seen') === '1'; } catch (_) { return true; }
    })();
    if (!landingSeen && !this.isSharedView && !isEmbed) {
      UI.showLandingGate();
    }
    
    // Try to authenticate if cloud is available
    await this.checkAuth();
    // Always clear any stale local caches once auth is known; we only trust server trips now
    Storage.clearTrips();

    // Fail-closed on auth expiry from any API call
    window.addEventListener('ride:auth-expired', () => this.handleAuthExpired());
    window.addEventListener('ride:connection-lost', (e) => this.handleConnectionLost(e?.detail));

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
      this.handleAuthErrorFromUrl(authError, authErrorDesc);
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
        // Prevent cross-account local state leaks (e.g., trip ordering) when a different user logs in.
        const lastUserId = localStorage.getItem('ride_last_user_id');
        if (lastUserId && lastUserId !== user.id) {
          Storage.clearTrips();
          Storage.setTripOrder([]);
        }
        localStorage.setItem('ride_last_user_id', user.id);

        this.currentUser = user;
        this.useCloud = true;
        this.updateUserUI();
        UI.hideAuthGate();
        UI.closeModal('loginModal');
        return true;
      }
      // No session present (401)
      localStorage.removeItem('ride_last_user_id');
      this.currentUser = null;
      this.useCloud = false;
      if (!UI.isLandingGateVisible()) {
        UI.showAuthGate('Signed out');
      }
      return false;
    } catch (error) {
      console.error('Auth check failed', error);
      const msg = error.status === 401
        ? 'Session expired. Please sign in again.'
        : 'Auth check failed. Working offline until re-auth.';
      UI.showToast(msg, 'info');
      // Reset user so UI reflects logged-out state on auth errors
      localStorage.removeItem('ride_last_user_id');
      this.currentUser = null;
      this.useCloud = false;
      if (!UI.isLandingGateVisible()) {
        UI.showAuthGate('Signed out');
      }
      // Preserve existing useCloud flag so we can retry when online/focused
      return false;
    }
  },

  handleAuthExpired() {
    // If we already consider ourselves logged out, nothing else to do.
    if (!this.currentUser && !this.useCloud) return;

    this.currentUser = null;
    this.useCloud = false;
    localStorage.removeItem('ride_last_user_id');
    this.updateUserUI();

    // Clear any in-memory trip state to avoid edits that cannot be saved.
    this.currentTrip = null;
    this.tripListCache = [];
    MapManager.clear();
    UI.renderTrips([], null);
    UI.renderWaypoints([]);
    UI.renderJournal([]);
    UI.updateTripTitle('');
    UI.updateTripStats(null);

    UI.showToast('Session expired. Please sign in again.', 'error');
    if (!this.isSharedView) {
      UI.closeModal('loginModal');
      UI.showAuthGate('Signed out — session expired');
    }
  },

  handleConnectionLost(detail) {
    // Always fail closed: treat connection loss like a sign-out.
    if (!this.currentUser && !this.useCloud) {
      if (!this.isSharedView) {
        UI.showAuthGate('Signed out');
      }
      return;
    }

    this.currentUser = null;
    this.useCloud = false;
    localStorage.removeItem('ride_last_user_id');
    this.updateUserUI();

    this.currentTrip = null;
    this.tripListCache = [];
    MapManager.clear();
    UI.renderTrips([], null);
    UI.renderWaypoints([]);
    UI.renderJournal([]);
    UI.updateTripTitle('');
    UI.updateTripStats(null);

    const kind = detail?.kind;
    const msg = kind === 'network'
      ? 'Signed out — connection lost.'
      : 'Signed out — server unavailable.';
    UI.showToast(msg, 'error');

    if (!this.isSharedView) {
      UI.closeModal('loginModal');
      UI.showAuthGate(kind === 'network' ? 'Signed out — connection lost' : 'Signed out — server unavailable');
    }
  },

  handleAuthErrorFromUrl(code, description) {
    let message = 'Login failed. Please try again.';
    if (code === 'invalid_state') {
      message = 'Login expired. Please try again.';
    } else if (code === 'request_malformed' || code === 'invalid_request') {
      message = 'Login request was invalid. Please retry.';
    }
    if (description) {
      message = `${message} (${description})`;
    }
    UI.showToast(message, 'error');
    // Strip auth error params to prevent repeated toasts when reloading
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('error');
    cleanUrl.searchParams.delete('error_description');
    window.history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
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
      const landingSeen = (() => {
        try { return localStorage.getItem('ride_landing_seen') === '1'; } catch (_) { return true; }
      })();
      if (!landingSeen) {
        UI.showLandingGate();
      } else {
        UI.showAuthGate('Signed out');
      }
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
        UI.showAuthGate('Signed out');
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
    const coverInput = document.getElementById('tripDetailCover');
    const focusXInput = document.getElementById('tripDetailCoverFocusX');
    const focusYInput = document.getElementById('tripDetailCoverFocusY');

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

    if (coverInput) {
      coverInput.addEventListener('input', () => this.updateCoverFocusUI());
    }

    if (focusXInput) {
      focusXInput.addEventListener('input', () => this.updateCoverFocusUI());
    }

    if (focusYInput) {
      focusYInput.addEventListener('input', () => this.updateCoverFocusUI());
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
      const imageUrl = coverInput?.value?.trim();
      preview.style.backgroundImage = imageUrl ? `url('${imageUrl}')` : 'none';
      preview.style.backgroundPosition = `${x}% ${y}%`;
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
    this.renderNoteAttachments(entry);
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

  renderNoteAttachments(entry) {
    const listEl = document.getElementById('noteAttachmentList');
    if (!listEl) return;
    const attachments = entry?.attachments || [];
    if (!attachments.length) {
      listEl.innerHTML = '<div class="microcopy">No attachments yet.</div>';
      return;
    }

    listEl.innerHTML = attachments.map((att) => {
      const name = UI.escapeHtml(att.original_name || att.filename || att.name || 'Attachment');
      return `
        <div class="attachment-pill" data-attachment-id="${att.id}">
          <a href="${att.url}" target="_blank" rel="noopener">${name}</a>
          <button type="button" class="attachment-remove" data-attachment-id="${att.id}" data-entry-id="${entry.id}" aria-label="Remove attachment">×</button>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.attachment-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const attachmentId = btn.dataset.attachmentId;
        const entryId = btn.dataset.entryId;
        if (attachmentId && entryId) {
          this.deleteAttachment(attachmentId, entryId);
        }
      });
    });
  },

  bindSessionRefresh() {
    // Re-verify session and refresh trips when returning to the app or regaining connectivity
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) return;
      const hadUser = !!this.currentUser;
      const authed = await this.checkAuth();
      if (authed || hadUser) {
        // Pull fresh data when user returns to the tab
        await this.refreshData('visibility');
      }
    });

    window.addEventListener('online', async () => {
      const authed = await this.checkAuth();
      if (authed) {
        await this.refreshData('online');
      }
    });
  },

  bindEvents() {
    this.bindJournalAttachmentPicker();
    this.bindWaypointDetails();
    this.bindRideControls();
  },

  bindWaypointDetails() {
    const form = document.getElementById('waypointDetailsForm');
    const fileInput = document.getElementById('waypointAttachmentFile');
    const fileBtn = document.getElementById('waypointAttachmentBtn');
    const fileName = document.getElementById('waypointAttachmentFileName');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('waypointDetailId')?.value || '';
        const name = document.getElementById('waypointDetailName')?.value?.trim() || '';
        const notes = document.getElementById('waypointDetailNotes')?.value?.trim() || '';
        if (!id) return;
        await this.updateWaypointDetails(id, { name, notes });
      });
    }

    if (fileBtn && fileInput) {
      fileBtn.addEventListener('click', () => {
        const id = document.getElementById('waypointDetailId')?.value || '';
        if (!id) {
          UI.showToast('Open a waypoint first', 'info');
          return;
        }
        fileInput.value = '';
        fileInput.dataset.waypointId = id;
        if (fileName) fileName.textContent = '';
        fileInput.click();
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', async () => {
        const waypointId = fileInput.dataset.waypointId;
        const file = fileInput.files?.[0];
        if (fileName) fileName.textContent = file ? file.name : '';
        if (!file || !waypointId) return;
        await this.uploadWaypointAttachment(waypointId, file);
      });
    }
  },

  openWaypointDetails(waypointId) {
    if (!this.currentTrip) return;
    const wp = (this.currentTrip.waypoints || []).find((w) => w.id === waypointId);
    if (!wp) return;
    const idEl = document.getElementById('waypointDetailId');
    const nameEl = document.getElementById('waypointDetailName');
    const notesEl = document.getElementById('waypointDetailNotes');
    if (idEl) idEl.value = wp.id;
    if (nameEl) nameEl.value = wp.name || '';
    if (notesEl) notesEl.value = wp.notes || '';
    this.renderWaypointAttachments(wp.id);
    UI.openModal('waypointDetailsModal');
  },

  renderWaypointAttachments(waypointId) {
    const listEl = document.getElementById('waypointAttachmentList');
    if (!listEl) return;
    const all = Array.isArray(this.currentTrip?.attachments) ? this.currentTrip.attachments : [];
    const attachments = all.filter((a) => a && a.waypoint_id === waypointId);
    if (!attachments.length) {
      listEl.innerHTML = '<div class="microcopy">No attachments yet.</div>';
      return;
    }

    listEl.innerHTML = attachments.map((att) => {
      const name = UI.escapeHtml(att.original_name || att.filename || att.name || 'Attachment');
      return `
        <div class="attachment-pill" data-attachment-id="${att.id}">
          <a href="${att.url}" target="_blank" rel="noopener">${name}</a>
          <button type="button" class="attachment-remove" data-attachment-id="${att.id}" aria-label="Remove attachment">×</button>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.attachment-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const attachmentId = btn.dataset.attachmentId;
        if (attachmentId) this.deleteAttachment(attachmentId);
      });
    });
  },

  async updateWaypointDetails(waypointId, data) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('update waypoints')) return;

    try {
      const res = await API.waypoints.update(this.currentTrip.id, waypointId, {
        name: data.name,
        notes: data.notes,
      }, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
      if (res?.waypoint) {
        Trip.updateWaypoint(this.currentTrip, waypointId, res.waypoint);
        this.currentTrip.waypoints = Trip.normalizeWaypointOrder(this.currentTrip.waypoints);
      } else {
        Trip.updateWaypoint(this.currentTrip, waypointId, { name: data.name, notes: data.notes });
      }
      this.markTripWritten(this.currentTrip.id);
      UI.renderWaypoints(this.currentTrip.waypoints);
      MapManager.updateWaypoints(this.currentTrip.waypoints);
      UI.showToast('Waypoint saved', 'success');
      await this.refreshTripsList();
    } catch (error) {
      console.error('Failed to update waypoint details:', error);
        if (error.status === 409 || error.status === 428) {
        await this.handleTripConflict(error);
        return;
      }
      UI.showToast('Waypoint update failed. Not saved.', 'error');
    }
  },

  async uploadWaypointAttachment(waypointId, file) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('upload attachments')) return;

    try {
      UI.showToast('Uploading attachment...', 'info');
      const attachment = await API.attachments.upload(this.currentTrip.id, file, {
        waypoint_id: waypointId,
        is_private: false,
        headers: this.getTripIfMatchHeaders(),
      });
      if (!this.currentTrip.attachments) this.currentTrip.attachments = [];
      const exists = this.currentTrip.attachments.some((a) => a.id === attachment.id);
      if (!exists) this.currentTrip.attachments.unshift(attachment);
      UI.showToast('Attachment uploaded', 'success');
      this.renderWaypointAttachments(waypointId);
    } catch (err) {
      console.error('Waypoint attachment upload failed', err);
        if (err.status === 409 || err.status === 428) {
        await this.handleTripConflict(err);
        return;
      }
      UI.showToast('Attachment upload failed', 'error');
    }
  },

  bindRideControls() {
    // Info button toggles stats panel
    document.getElementById('rideInfoBtn')?.addEventListener('click', () => {
      document.getElementById('rideStatsPanel')?.classList.toggle('hidden');
    });

    // Add button opens action sheet
    document.getElementById('rideAddBtn')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.remove('hidden');
    });

    // Close action sheet
    document.getElementById('rideAddSheetClose')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.add('hidden');
    });

    // Add note from ride mode
    document.getElementById('rideAddNoteBtn')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.add('hidden');
      if (!this.ensureEditable('add a note')) return;
      UI.openModal('noteModal');
    });

    // Take photo from ride mode
    document.getElementById('rideAddPhotoBtn')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.add('hidden');
      if (!this.ensureEditable('add a photo')) return;
      document.getElementById('ridePhotoInput')?.click();
    });

    // Handle photo capture
    document.getElementById('ridePhotoInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await this.addPhotoAttachment(file);
      e.target.value = '';
    });

    // Recenter button
    document.getElementById('rideRecenterBtn')?.addEventListener('click', () => {
      MapManager.recenterRide();
    });

    // Exit button (FAB)
    document.getElementById('rideExitBtn')?.addEventListener('click', () => {
      this.exitRideMode();
    });

    // Exit button (top banner)
    document.getElementById('rideBannerExitBtn')?.addEventListener('click', () => {
      this.exitRideMode();
    });
  },

  async addPhotoAttachment(file) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('save photos')) return;

    const title = `Photo ${new Date().toLocaleString()}`;
    let entry;
    try {
      entry = await API.journal.add(this.currentTrip.id, {
        title,
        content: '',
        is_private: false,
        tags: []
      });
      if (!this.currentTrip.journal) this.currentTrip.journal = [];
      entry.attachments = [];
      this.currentTrip.journal.push(entry);
    } catch (err) {
      console.error('Failed to create photo note', err);
      UI.showToast('Could not create note for photo.', 'error');
      return;
    }

    try {
      UI.showToast('Uploading photo...', 'info');
      const attachment = await API.attachments.upload(this.currentTrip.id, file, { journal_entry_id: entry.id });
      this.addAttachmentToEntry(entry.id, attachment, true);
      UI.showToast('Photo saved to trip', 'success');
    } catch (err) {
      console.error('Photo upload failed', err);
      UI.showToast('Photo upload failed', 'error');
    }

    UI.renderJournal(this.currentTrip.journal);
    this.renderNoteAttachments(entry);
  },

  addAttachmentToEntry(entryId, attachment, prepend = false) {
    if (!this.currentTrip) return;
    if (!this.currentTrip.attachments) this.currentTrip.attachments = [];
    const existingTripAttachmentIndex = this.currentTrip.attachments.findIndex((a) => a.id === attachment.id);
    if (existingTripAttachmentIndex === -1) {
      if (prepend) {
        this.currentTrip.attachments.unshift(attachment);
      } else {
        this.currentTrip.attachments.push(attachment);
      }
    }

    const entry = (this.currentTrip.journal || []).find((e) => e.id === entryId);
    if (!entry) return;
    if (!entry.attachments) entry.attachments = [];
    const existing = entry.attachments.find((a) => a.id === attachment.id);
    if (!existing) {
      if (prepend) {
        entry.attachments.unshift(attachment);
      } else {
        entry.attachments.push(attachment);
      }
    }
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
      // Calculate distance from current position to the start of the next step
      const distToNextStep = nextStep.index > nearestIdx
        ? cumulative[nextStep.index] - cumulative[nearestIdx]
        : bestDist; // Already at/past this step, show distance to nearest point
      document.getElementById('rideNextMeta').textContent = `${this.formatDistance(distToNextStep)} ahead`;
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
    const userInitial = document.getElementById('userInitial');
    
    if (this.currentUser) {
      console.log('[updateUserUI] user:', this.currentUser.name, 'avatar:', this.currentUser.avatar_url);
      userBtn.classList.add('logged-in');
      if (this.currentUser.avatar_url) {
        userAvatar.src = this.currentUser.avatar_url;
        userAvatar.classList.remove('hidden');
        userInitial.classList.add('hidden');
      } else {
        // Show initial-based avatar when no photo is available
        userAvatar.classList.add('hidden');
        userAvatar.removeAttribute('src');
        const name = this.currentUser.name || this.currentUser.email || '?';
        const letter = name.charAt(0).toUpperCase();
        console.log('[updateUserUI] showing initial:', letter);
        userInitial.textContent = letter;
        userInitial.style.backgroundColor = this._initialColor(name);
        userInitial.classList.remove('hidden');
      }
    } else {
      userBtn.classList.remove('logged-in');
      userAvatar.classList.add('hidden');
      userInitial.classList.add('hidden');
    }
  },

  /**
   * Deterministic colour from a string — warm, muted palette that works on dark UI
   */
  _initialColor(str) {
    const palette = [
      '#6366f1', // indigo
      '#8b5cf6', // violet
      '#a855f7', // purple
      '#ec4899', // pink
      '#ef4444', // red
      '#f97316', // orange
      '#eab308', // yellow
      '#22c55e', // green
      '#14b8a6', // teal
      '#06b6d4', // cyan
      '#3b82f6', // blue
      '#0ea5e9', // sky
    ];
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return palette[Math.abs(hash) % palette.length];
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

  setWaypointsSaving(isSaving) {
    const list = document.getElementById('waypointsList');
    if (!list) return;
    list.classList.toggle('is-saving', !!isSaving);
    list.setAttribute('aria-busy', isSaving ? 'true' : 'false');
    // Align with CSS selector without relying on IDs in CSS.
    list.classList.add('waypoints-list');
  },

  /**
   * Load initial trip (from cloud or local storage)
   */
  async loadInitialTrip() {
    if (this.useCloud && this.currentUser) {
      // Load from cloud
      try {
        let trips = await API.trips.list();
        const pendingImportedId = localStorage.getItem('ride_imported_trip_id');

        if (trips.length > 0) {
          const targetId = (pendingImportedId && trips.some((t) => t.id === pendingImportedId))
            ? pendingImportedId
            : trips[0].id;

          const trip = await API.trips.get(targetId);
          if (pendingImportedId) {
            localStorage.removeItem('ride_imported_trip_id');
            this.bumpTripToTop(targetId);
          }
          this.loadTripData(trip);
        } else {
          this.createNewTrip();
        }
      } catch (error) {
        console.error('Failed to load cloud trips:', error);
        UI.showToast('Unable to load trips from server. Please retry online.', 'error');
        UI.renderTrips([], null);
        UI.renderWaypoints([]);
        UI.renderJournal([]);
        UI.updateTripTitle('');
        UI.updateTripStats(null);
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
  normalizeTrip(trip) {
    if (!trip) return trip;
    const normalized = { ...trip };
    if (!normalized.updatedAt && normalized.updated_at) normalized.updatedAt = normalized.updated_at;
    if (!normalized.createdAt && normalized.created_at) normalized.createdAt = normalized.created_at;
    if (normalized.waypoints) {
      normalized.waypoints = Trip.normalizeWaypointOrder(normalized.waypoints);
    }

    // Normalize route shape across client/server:
    // - server uses {distance, duration, coordinates}
    // - client route builders historically used {distance, time, coordinates}
    if (normalized.route) {
      const duration = normalized.route.duration ?? normalized.route.time ?? null;
      normalized.route = {
        ...normalized.route,
        duration,
        time: duration,
        coordinates: normalized.route.coordinates || []
      };
    }

    if (!Number.isFinite(normalized.cover_focus_x)) normalized.cover_focus_x = 50;
    if (!Number.isFinite(normalized.cover_focus_y)) normalized.cover_focus_y = 50;
    return normalized;
  },

  getTripSortTimestamp(trip) {
    const ts = trip?.updatedAt || trip?.updated_at || trip?.createdAt || trip?.created_at;
    return ts ? new Date(ts).getTime() : 0;
  },

  markTripWritten(tripId) {
    if (!tripId) return;
    if (!this.tripWriteClock) this.tripWriteClock = {};
    this.tripWriteClock[tripId] = Date.now();
  },

  cacheTripData(trip) {
    if (!trip || !trip.id) return;
    if (!this.tripDataCache) this.tripDataCache = {};
    this.tripDataCache[trip.id] = trip;
  },

  getCachedTrip(tripId) {
    return this.tripDataCache?.[tripId] || null;
  },

  getTripIfMatchHeaders(trip = this.currentTrip) {
    const version = Number(trip?.version);
    if (!Number.isFinite(version)) return {};
    return { 'If-Match': String(version) };
  },

  applyTripMetaFromResponse(trip, meta) {
    if (!trip || !meta) return;
    if (meta.trip_version !== undefined) {
      const v = Number(meta.trip_version);
      if (Number.isFinite(v)) trip.version = v;
    }
    if (meta.trip_updated_at !== undefined && meta.trip_updated_at) {
      trip.updated_at = meta.trip_updated_at;
      trip.updatedAt = meta.trip_updated_at;
    }
  },

  async handleTripConflict(err) {
    UI.showToast('Trip changed on another device. Reloading latest…', 'info');
    try {
      await this.refreshData('conflict');
    } catch (_) {
      // ignore
    }
  },

  applyTripOrder(trips) {
    const normalizedTrips = trips.map((t) => this.normalizeTrip(t));
    const order = Storage.getTripOrder() || [];
    const byId = new Map(normalizedTrips.map((t) => [t.id, t]));
    const seen = new Set();
    const ordered = [];

    order.forEach((id) => {
      const trip = byId.get(id);
      if (trip) {
        ordered.push(trip);
        seen.add(id);
      }
    });

    const remaining = normalizedTrips
      .filter((t) => !seen.has(t.id))
      .sort((a, b) => this.getTripSortTimestamp(b) - this.getTripSortTimestamp(a));

    const finalList = [...ordered, ...remaining];
    Storage.setTripOrder(finalList.map((t) => t.id));
    return finalList;
  },

  bumpTripToTop(tripId) {
    const order = Storage.getTripOrder().filter((id) => id !== tripId);
    Storage.setTripOrder([tripId, ...order]);
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
        this.bumpTripToTop(fullTrip.id);
        this.refreshTripsList();
        UI.showToast('New trip created', 'success');
        return;
      } catch (error) {
        console.error('Failed to create cloud trip:', error);
        UI.showToast('Session expired or offline. Using offline mode.', 'info');
        UI.showToast('Login required to create trips.', 'error');
        return;
      }
    }
    UI.showToast('Login to create and save trips.', 'error');
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
        UI.showToast('Login to view trip details.', 'error');
        return;
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
    const focusXInput = document.getElementById('tripDetailCoverFocusX');
    const focusYInput = document.getElementById('tripDetailCoverFocusY');
    if (focusXInput) focusXInput.value = Number.isFinite(trip.cover_focus_x) ? trip.cover_focus_x : 50;
    if (focusYInput) focusYInput.value = Number.isFinite(trip.cover_focus_y) ? trip.cover_focus_y : 50;
    const coverFileName = document.getElementById('tripDetailCoverFileName');
    if (coverFileName) coverFileName.textContent = '';
    document.getElementById('tripDetailPublic').checked = !!trip.is_public;
    const linkInput = document.getElementById('tripDetailLink');
    const link = trip.short_url || (trip.short_code ? `${window.location.origin}/${trip.short_code}` : '');
    linkInput.value = link || '';
    document.getElementById('tripDetailsModal').dataset.tripId = trip.id;
    this.updateCoverFocusUI();
  },

  async saveTripDetails() {
    const name = document.getElementById('tripDetailName').value.trim();
    const description = document.getElementById('tripDetailDescription').value.trim();
    const coverInput = document.getElementById('tripDetailCover');
    const coverFileInput = document.getElementById('tripDetailCoverFile');
    const coverFile = coverFileInput?.files?.[0];
    let coverImageUrl = coverInput?.value?.trim() || '';
    const focusXRaw = Number(document.getElementById('tripDetailCoverFocusX')?.value);
    const focusYRaw = Number(document.getElementById('tripDetailCoverFocusY')?.value);
    const coverFocusX = Number.isFinite(focusXRaw) ? focusXRaw : 50;
    const coverFocusY = Number.isFinite(focusYRaw) ? focusYRaw : 50;
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
        if (coverInput) {
          coverInput.value = coverImageUrl;
          this.updateCoverFocusUI();
        }
      }
      if (this.useCloud && this.currentUser) {
        await API.trips.update(tripId, { name, description, is_public: isPublic, cover_image_url: coverImageUrl || null, cover_focus_x: coverFocusX, cover_focus_y: coverFocusY });

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
        UI.showToast('Login to update trips.', 'error');
        return;
      }

      updatedTrip = this.normalizeTrip(updatedTrip);
      updatedTrip.cover_focus_x = coverFocusX;
      updatedTrip.cover_focus_y = coverFocusY;

      if (this.currentTrip?.id === updatedTrip.id) {
        this.currentTrip = { ...this.currentTrip, ...updatedTrip };
        this.loadTripData(this.currentTrip);
      }

      // Refresh cached list entry optimistically
      if (Array.isArray(this.tripListCache) && this.tripListCache.length) {
        this.tripListCache = this.tripListCache.map((t) => t.id === updatedTrip.id ? { ...t, ...updatedTrip } : t);
        UI.renderTrips(this.tripListCache, this.currentTrip?.id || updatedTrip.id);
      } else {
        this.refreshTripsList();
      }

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
    const normalized = this.normalizeTrip(trip);
    if (this.currentTrip?.id === normalized?.id) {
      this.loadTripData(normalized);
    }
  },

  /**
   * Load trip data into the app
   */
  loadTripData(trip) {
    // Normalize share settings for downstream sharing UI
    Trip.ensureShareSettings(trip);
    if (trip.waypoints) {
      trip.waypoints = Trip.normalizeWaypointOrder(trip.waypoints);
    }
    trip = this.normalizeTrip(trip);
    if (!Number.isFinite(Number(trip.version))) {
      trip.version = 0;
    } else {
      trip.version = Number(trip.version);
    }
    this.attachJournalAttachments(trip);
    this.currentTrip = trip;
    this.cacheTripData(trip);
    
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

  attachJournalAttachments(trip) {
    if (!trip) return;
    const attachments = Array.isArray(trip.attachments) ? trip.attachments : [];
    const byEntry = new Map();
    attachments.forEach((att) => {
      const entryId = att.journal_entry_id || att.journalEntryId;
      if (!entryId) return;
      if (!byEntry.has(entryId)) byEntry.set(entryId, []);
      byEntry.get(entryId).push(att);
    });

    trip.journal = (trip.journal || []).map((entry) => ({
      ...entry,
      attachments: byEntry.get(entry.id) || entry.attachments || []
    }));
    trip.attachments = attachments;
  },

  /**
   * Load a trip by ID
   */
  async loadTrip(tripId) {
    if (this.useCloud && this.currentUser) {
      try {
        const trip = this.normalizeTrip(await API.trips.get(tripId));

        // Guard against stale reads overwriting a freshly reordered waypoint list.
        // This can happen with replica lag: another edge may briefly serve an older
        // trip version and old waypoint sort_order after a successful reorder.
        const cached = this.getCachedTrip(tripId);
        const localWriteAt = this.tripWriteClock?.[tripId] || 0;
        const sinceWriteMs = localWriteAt ? (Date.now() - localWriteAt) : Infinity;
        const serverV = Number(trip?.version);
        const cachedV = Number(cached?.version);
        const serverTs = this.getTripSortTimestamp(trip);
        const cachedTs = this.getTripSortTimestamp(cached);

        const serverLooksOlderThanCache = !!cached && (
          (Number.isFinite(serverV) && Number.isFinite(cachedV) && serverV < cachedV)
          // Only consider timestamp lag during a short window after a local write.
          // This avoids noisy warnings when versions are equal and no recent write occurred.
          || (sinceWriteMs >= 0 && sinceWriteMs < 15000 && cachedTs && serverTs && serverTs + 1500 < cachedTs)
        );

        if (serverLooksOlderThanCache) {
          console.warn('loadTrip returned older trip data; keeping cached and retrying', {
            tripId,
            serverV,
            cachedV,
            serverTs,
            cachedTs,
            localWriteAt,
          });

          // Keep UI stable on the cached (newer) version.
          if (cached) {
            this.loadTripData(cached);
          }
          this.refreshTripsList();
          UI.switchView('map');
          UI.showToast(`Loaded: ${cached?.name || trip.name}`, 'success');

          setTimeout(async () => {
            try {
              if (!this.useCloud || !this.currentUser) return;
              if (this.currentTrip?.id !== tripId) return;
              const retryTrip = this.normalizeTrip(await API.trips.get(tripId));

              const retryServerV = Number(retryTrip?.version);
              const retryCachedV = Number(this.getCachedTrip(tripId)?.version);
              if (Number.isFinite(retryServerV) && Number.isFinite(retryCachedV) && retryServerV < retryCachedV) {
                return;
              }
              this.loadTripData(retryTrip);
            } catch (_) {
              // ignore retry errors
            }
          }, 1500);

          return;
        }

        this.loadTripData(trip);
        this.refreshTripsList();
        UI.switchView('map');
        UI.showToast(`Loaded: ${trip.name}`, 'success');
        return;
      } catch (error) {
        console.error('Failed to load cloud trip:', error);
        UI.showToast('Unable to load trip from server.', 'error');
      }
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
        trip.waypoints = Trip.normalizeWaypointOrder(sharedData.waypoints || []);
        trip.journal = sharedData.journal || [];
        trip.customRoutePoints = sharedData.customRoutePoints || [];
        trip.share_id = sharedData.share_id;
        trip.short_code = sharedData.short_code;
        trip.is_public = sharedData.is_public;
        trip.cover_image_url = sharedData.cover_image_url || sharedData.cover_image || '';
        trip.cover_focus_x = Number.isFinite(sharedData.cover_focus_x) ? sharedData.cover_focus_x : 50;
        trip.cover_focus_y = Number.isFinite(sharedData.cover_focus_y) ? sharedData.cover_focus_y : 50;
        
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
    
    if (this.useCloud && this.currentUser) {
      try {
        const route = this.currentTrip.route
          ? {
              coordinates: this.currentTrip.route.coordinates || [],
              distance: this.currentTrip.route.distance ?? null,
              duration: this.currentTrip.route.duration ?? this.currentTrip.route.time ?? null,
              steps: this.currentTrip.route.steps || []
            }
          : null;

        const updated = await API.trips.update(this.currentTrip.id, {
          name: this.currentTrip.name,
          description: this.currentTrip.description,
          settings: this.currentTrip.settings,
          route,
          cover_image_url: this.currentTrip.cover_image_url,
          cover_focus_x: this.currentTrip.cover_focus_x,
          cover_focus_y: this.currentTrip.cover_focus_y
        }, { headers: this.getTripIfMatchHeaders() });

        if (updated) {
          if (updated.updated_at) {
            this.currentTrip.updated_at = updated.updated_at;
            this.currentTrip.updatedAt = updated.updated_at;
          }
          if (updated.version !== undefined) {
            const v = Number(updated.version);
            if (Number.isFinite(v)) this.currentTrip.version = v;
          }
        }
        this.markTripWritten(this.currentTrip.id);
        return true;
      } catch (error) {
        console.error('Failed to save to cloud:', error);
        if (error.status === 409) {
          await this.handleTripConflict(error);
          return false;
        }
        if (error.status === 404) {
          // Trip missing on server; recover by reloading or creating a fresh trip
          UI.showToast('Trip missing on server. Reloading your trips…', 'error');
          await this.loadInitialTrip();
        } else {
          UI.showToast('Save failed. Not saved to cloud.', 'error');
        }
        return false;
      }
    }

    return false;
  },

  /**
   * Add waypoint to current trip
   */
  async addWaypoint(data) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('add waypoints')) return null;

    let waypoint;
    try {
      const res = await API.waypoints.add(this.currentTrip.id, data, { headers: this.getTripIfMatchHeaders() });
      waypoint = res.waypoint;
      this.applyTripMetaFromResponse(this.currentTrip, res);
      if (!this.currentTrip.waypoints) this.currentTrip.waypoints = [];
      this.currentTrip.waypoints.push(waypoint);
      this.currentTrip.waypoints = Trip.normalizeWaypointOrder(this.currentTrip.waypoints);

      // Preserve persisted ordering if present; otherwise initialize from current list.
      if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') this.currentTrip.settings = {};
      const ids = (this.currentTrip.waypoints || []).map((w) => w.id);
      this.currentTrip.settings.waypoint_order = ids;
      this.markTripWritten(this.currentTrip.id);
    } catch (error) {
      console.error('Failed to add waypoint to cloud:', error);
      if (error.status === 409 || error.status === 428) {
        await this.handleTripConflict(error);
        return null;
      }
      UI.showToast('Could not add waypoint (not saved)', 'error');
      return null;
    }
    
    // Update UI and map
    UI.renderWaypoints(this.currentTrip.waypoints);
    MapManager.addWaypointMarker(waypoint);

    // Keep trips list counts fresh so users can see the save landed.
    await this.refreshTripsList();
    UI.showToast('Waypoint saved', 'success');
    
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
    if (!this.ensureEditable('move waypoints')) return;

    try {
      const res = await API.waypoints.update(this.currentTrip.id, waypointId, { lat, lng }, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
      if (res?.waypoint) {
        Trip.updateWaypoint(this.currentTrip, waypointId, res.waypoint);
        this.currentTrip.waypoints = Trip.normalizeWaypointOrder(this.currentTrip.waypoints);
      }
    } catch (error) {
      console.error('Failed to update waypoint:', error);
      if (error.status === 409 || error.status === 428) {
        await this.handleTripConflict(error);
        return;
      }
      UI.showToast('Move failed. Not saved to cloud.', 'error');
      return;
    }

    if (!this.currentTrip.waypoints?.some((w) => w.id === waypointId && w.lat === lat && w.lng === lng)) {
      Trip.updateWaypoint(this.currentTrip, waypointId, { lat, lng });
    }
    this.markTripWritten(this.currentTrip.id);

    const now = Date.now();
    if (now - (this.waypointSaveToastAt || 0) > 2500) {
      this.waypointSaveToastAt = now;
      UI.showToast('Waypoint saved', 'success');
    }
    
    // Update route
    if (this.currentTrip.waypoints.length >= 2) {
      MapManager.updateRoute(this.currentTrip.waypoints);
    }
    
    UI.renderWaypoints(this.currentTrip.waypoints);
    await this.refreshTripsList();
  },

  /**
   * Delete waypoint
   */
  async deleteWaypoint(waypointId) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('delete waypoints')) return;
    
    try {
      const res = await API.waypoints.delete(this.currentTrip.id, waypointId, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
    } catch (error) {
      console.error('Failed to delete waypoint:', error);
      if (error.status === 409 || error.status === 428) {
        await this.handleTripConflict(error);
        return;
      }
    }
    
    Trip.removeWaypoint(this.currentTrip, waypointId);

    if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') this.currentTrip.settings = {};
    const ids = (this.currentTrip.waypoints || []).map((w) => w.id);
    this.currentTrip.settings.waypoint_order = ids;
    this.markTripWritten(this.currentTrip.id);
    
    MapManager.removeWaypointMarker(waypointId);
    UI.renderWaypoints(this.currentTrip.waypoints);
    
    // Update or clear route
    if (this.currentTrip.waypoints.length >= 2) {
      MapManager.updateRoute(this.currentTrip.waypoints);
    } else {
      MapManager.clearRoute();
    }
    
    UI.showToast('Waypoint deleted', 'success');
    await this.refreshTripsList();
  },

  /**
   * Reorder waypoints
   */
  async reorderWaypoints(orderIds) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('reorder waypoints')) return;

    if (this.isReorderingWaypoints) return;
    this.isReorderingWaypoints = true;

    this.setWaypointsSaving(true);

    try {
      // Update local order
      Trip.reorderWaypoints(this.currentTrip, orderIds);

      // Persist
      const res = await API.waypoints.reorder(this.currentTrip.id, orderIds, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);

      // Keep settings in sync so subsequent saveCurrentTrip() calls (e.g., route autosave)
      // don't overwrite the trip settings and wipe the persisted waypoint order.
      if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') this.currentTrip.settings = {};
      this.currentTrip.settings.waypoint_order = Array.isArray(orderIds) ? orderIds.slice() : [];

      this.markTripWritten(this.currentTrip.id);

      // Refresh UI and map
      UI.renderWaypoints(this.currentTrip.waypoints);
      MapManager.updateWaypoints(this.currentTrip.waypoints);

      await this.refreshTripsList();
      UI.showToast('Waypoint order saved', 'success');
    } catch (error) {
      console.error('Failed to reorder waypoints in cloud:', error);
      if (error.status === 409 || error.status === 428) {
        await this.handleTripConflict(error);
        return;
      }
      UI.showToast('Reorder failed. Not saved to cloud.', 'error');
    } finally {
      this.setWaypointsSaving(false);
      this.isReorderingWaypoints = false;
    }
  },

  /**
   * Add journal entry
   */
  async addJournalEntry(data) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('add notes')) return null;

    let entry;
    try {
      entry = await API.journal.add(this.currentTrip.id, {
        title: data.title,
        content: data.content,
        is_private: data.isPrivate,
        tags: data.tags
      });
      if (!this.currentTrip.journal) this.currentTrip.journal = [];
      entry.attachments = [];
      this.currentTrip.journal.push(entry);
    } catch (error) {
      console.error('Failed to add journal entry:', error);
      UI.showToast('Note not saved to cloud.', 'error');
      return null;
    }
    
    UI.renderJournal(this.currentTrip.journal);
    
    return entry;
  },

  async updateJournalEntry(entryId, data) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('update notes')) return null;
    let updated;
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

    // Sync local array
    if (updated) {
      const idx = this.currentTrip.journal.findIndex((e) => e.id === entryId);
      if (idx >= 0) {
        const existing = this.currentTrip.journal[idx];
        this.currentTrip.journal[idx] = { ...updated, attachments: existing?.attachments || [] };
      }
    }

    UI.renderJournal(this.currentTrip.journal);
    return updated;
  },

  /**
   * Delete journal entry
   */
  async deleteJournalEntry(entryId) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('delete notes')) return;

    try {
      await API.journal.delete(this.currentTrip.id, entryId);
    } catch (error) {
      console.error('Failed to delete journal entry:', error);
      UI.showToast('Delete failed on cloud.', 'error');
      return;
    }
    
    Trip.removeJournalEntry(this.currentTrip, entryId);
    this.saveCurrentTrip();
    
    UI.renderJournal(this.currentTrip.journal);
    UI.showToast('Note deleted', 'success');
  },

  async uploadJournalAttachment(entryId, file) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('upload attachments')) return;
    try {
      UI.showToast('Uploading attachment...', 'info');
      const attachment = await API.attachments.upload(this.currentTrip.id, file, { journal_entry_id: entryId });
      this.addAttachmentToEntry(entryId, attachment, true);
      UI.showToast('Attachment uploaded', 'success');
    } catch (err) {
      console.error('Attachment upload failed', err);
      UI.showToast('Attachment upload failed', 'error');
      return;
    }

    UI.renderJournal(this.currentTrip.journal);
    const entry = (this.currentTrip.journal || []).find((e) => e.id === entryId);
    if (entry) {
      this.renderNoteAttachments(entry);
    }
  },

  removeAttachmentFromState(attachmentId) {
    if (!this.currentTrip) return;
    if (Array.isArray(this.currentTrip.attachments)) {
      this.currentTrip.attachments = this.currentTrip.attachments.filter((a) => a.id !== attachmentId);
    }
    if (Array.isArray(this.currentTrip.journal)) {
      this.currentTrip.journal.forEach((entry) => {
        if (Array.isArray(entry.attachments)) {
          entry.attachments = entry.attachments.filter((a) => a.id !== attachmentId);
        }
      });
    }
  },

  async deleteAttachment(attachmentId, entryId) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('remove attachments')) return;

    try {
      await API.attachments.delete(attachmentId, { headers: this.getTripIfMatchHeaders() });
      this.removeAttachmentFromState(attachmentId);
      UI.showToast('Attachment removed', 'success');
    } catch (err) {
      console.error('Failed to delete attachment', err);
      UI.showToast('Could not delete attachment', 'error');
      return;
    }

    UI.renderJournal(this.currentTrip.journal || []);
    if (entryId) {
      const entry = (this.currentTrip.journal || []).find((e) => e.id === entryId);
      if (entry) {
        this.renderNoteAttachments(entry);
      }
    }

    // If waypoint details modal is open, refresh its attachment list too.
    const wpModal = document.getElementById('waypointDetailsModal');
    if (wpModal && !wpModal.classList.contains('hidden')) {
      const waypointId = document.getElementById('waypointDetailId')?.value || '';
      if (waypointId) this.renderWaypointAttachments(waypointId);
    }
  },

  /**
   * Save route data from routing control
   */
  async saveRouteData(routeData) {
    if (!this.currentTrip) return;
    if (!this.ensureEditable('save routes')) return;

    const duration = routeData?.duration ?? routeData?.time ?? null;
    this.currentTrip.route = {
      ...routeData,
      duration,
      time: duration,
      coordinates: routeData?.coordinates || []
    };
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

    const ok = await this.saveCurrentTrip();
    if (ok) {
      this.markTripWritten(this.currentTrip.id);
      UI.showToast('New route saved', 'success');
      await this.refreshTripsList();
    } else {
      UI.showToast('Route not saved', 'error');
    }
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
        trips = [];
        UI.showToast('Unable to load trips from server.', 'error');
      }
    } else {
      trips = [];
    }
    
    const currentId = this.currentTrip?.id;
    if (!trips.length) {
      Storage.setTripOrder([]);
      this.tripListCache = [];
      UI.renderTrips([], currentId);
      return;
    }

    const normalized = trips.map((t) => this.normalizeTrip(t));
    const orderedTrips = this.applyTripOrder(normalized);
    this.tripListCache = orderedTrips;
    UI.renderTrips(orderedTrips, currentId);
  },

  /**
   * Refresh current trip data and list from the server (for trips, journal, waypoints views)
   */
  async refreshData(source = 'manual') {
    if (this.isRefreshing) return;
    if (!this.useCloud || !this.currentUser) {
      UI.showToast('Login to refresh from cloud.', 'error');
      return;
    }

    this.isRefreshing = true;
    try {
      const trips = await API.trips.list();
      const normalized = trips.map((t) => this.normalizeTrip(t));
      const orderedTrips = this.applyTripOrder(normalized);
      this.tripListCache = orderedTrips;

      const currentId = this.currentTrip?.id || null;
      const currentExists = currentId ? orderedTrips.some((t) => t.id === currentId) : false;
      const fallbackTripId = orderedTrips[0]?.id ?? null;
      const targetTripId = currentExists ? currentId : fallbackTripId;

      UI.renderTrips(orderedTrips, targetTripId);

      if (!targetTripId) {
        MapManager.clear();
        UI.renderWaypoints([]);
        UI.renderJournal([]);
        UI.updateTripTitle('');
        UI.updateTripStats(null);
        UI.showToast('No trips available to refresh.', 'info');
        return;
      }

      const loadFreshTrip = async (tripId) => {
        try {
          return this.normalizeTrip(await API.trips.get(tripId));
        } catch (err) {
          if (err.status === 404) return null; // Gracefully handle missing trips
          throw err;
        }
      };

      let freshTrip = await loadFreshTrip(targetTripId);

      // If the previously selected trip is gone, fall back to the first available
      if (!freshTrip && fallbackTripId && fallbackTripId !== targetTripId) {
        freshTrip = await loadFreshTrip(fallbackTripId);
      }

      if (!freshTrip) {
        MapManager.clear();
        UI.renderWaypoints([]);
        UI.renderJournal([]);
        UI.updateTripTitle('');
        UI.updateTripStats(null);
        UI.showToast('Trip not found. Please try again.', 'error');
        return;
      }

      // Guard against clobbering: if we *just* wrote in this tab and the server read
      // appears older, keep local state and retry once shortly after.
      const localWriteAt = this.tripWriteClock?.[freshTrip.id] || 0;
      const sinceWriteMs = localWriteAt ? (Date.now() - localWriteAt) : Infinity;
      const serverV = Number(freshTrip?.version);
      const localV = Number(this.currentTrip?.version);
      const serverTs = this.getTripSortTimestamp(freshTrip);
      const localTs = this.getTripSortTimestamp(this.currentTrip);
      const serverLooksOlderThanLocal = (Number.isFinite(serverV) && Number.isFinite(localV) && serverV < localV)
        // Only consider timestamp lag during a short window after a local write.
        || (sinceWriteMs >= 0 && sinceWriteMs < 15000 && localTs && serverTs && serverTs + 1500 < localTs);

      if (source === 'visibility' && serverLooksOlderThanLocal) {
        console.warn('Refresh returned older trip data; retrying shortly', { source, tripId: freshTrip.id, serverTs, localTs, localWriteAt });
        setTimeout(async () => {
          try {
            if (!this.useCloud || !this.currentUser) return;
            // Only retry if we're still on the same trip.
            if (this.currentTrip?.id !== freshTrip.id) return;
            const retryTrip = await loadFreshTrip(freshTrip.id);
            if (!retryTrip) return;

            // Never apply an older server read over a newer local state.
            const retryServerV = Number(retryTrip?.version);
            const retryLocalV = Number(this.currentTrip?.version);
            const retryServerTs = this.getTripSortTimestamp(retryTrip);
            const retryLocalTs = this.getTripSortTimestamp(this.currentTrip);
            const retryLocalWriteAt = this.tripWriteClock?.[retryTrip.id] || 0;
            const retrySinceWriteMs = retryLocalWriteAt ? (Date.now() - retryLocalWriteAt) : Infinity;

            const retryStillOlder = (Number.isFinite(retryServerV) && Number.isFinite(retryLocalV) && retryServerV < retryLocalV)
              || (retrySinceWriteMs >= 0 && retrySinceWriteMs < 15000 && retryLocalTs && retryServerTs && retryServerTs + 1500 < retryLocalTs);

            if (retryStillOlder) {
              console.warn('Retry still returned older trip data; keeping local state', {
                tripId: retryTrip.id,
                retryServerV,
                retryLocalV,
                retryServerTs,
                retryLocalTs,
                retryLocalWriteAt
              });
              return;
            }

            this.loadTripData(retryTrip);
          } catch (e) {
            // ignore retry errors
          }
        }, 1500);
        return;
      }

      this.loadTripData(freshTrip);
      UI.showToast('Latest data loaded', 'success');
    } catch (error) {
      console.error('Refresh failed:', error);
      UI.showToast('Refresh failed. Please try again.', 'error');
    } finally {
      this.isRefreshing = false;
    }
  },

  reorderTrips(tripId, direction) {
    if (!this.tripListCache || this.tripListCache.length === 0) return;

    const trips = [...this.tripListCache];
    const index = trips.findIndex((t) => t.id === tripId);
    if (index === -1) return;

    const delta = direction === 'up' ? -1 : 1;
    const target = index + delta;
    if (target < 0 || target >= trips.length) return;

    [trips[index], trips[target]] = [trips[target], trips[index]];
    Storage.setTripOrder(trips.map((t) => t.id));
    this.tripListCache = trips;
    UI.renderTrips(trips, this.currentTrip?.id);
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
    
    Storage.setTripOrder(Storage.getTripOrder().filter((id) => id !== tripId));
    this.tripListCache = (this.tripListCache || []).filter((t) => t.id !== tripId);
    
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
