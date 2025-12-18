/**
 * UI module - handles DOM interactions and rendering
 */
const UI = {
  currentView: 'map',
  toastTimeout: null,
  placeSearchBias: null,
  placeSearchResults: [],

  /**
   * Initialize UI
   */
  init() {
    this.bindNavigation();
    this.bindRefreshButtons();
    this.bindMenu();
    this.bindModals();
    this.bindForms();
    this.bindPullToRefresh();
    this.bindPlaceSearch();
    this.bindFullscreen();
    const attachmentList = document.getElementById('noteAttachmentList');
    if (attachmentList) attachmentList.innerHTML = '<div class="microcopy">No attachments yet.</div>';
    return this;
  },

  bindRefreshButtons() {
    const attach = (id, view) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await App.refreshData(view);
        } finally {
          btn.disabled = false;
        }
      });
    };

    attach('refreshWaypointsBtn', 'waypoints');
    attach('refreshJournalBtn', 'journal');
    attach('refreshTripsBtn', 'trips');
  },

  bindPullToRefresh() {
    const addPTR = (elementId, view) => {
      const el = document.getElementById(elementId);
      if (!el) return;
      let startY = 0;
      let pulling = false;
      let triggered = false;
      const threshold = 60;

      const onStart = (e) => {
        if (el.scrollTop > 0) return;
        startY = e.touches?.[0]?.clientY ?? 0;
        pulling = true;
        triggered = false;
      };

      const onMove = (e) => {
        if (!pulling) return;
        const currentY = e.touches?.[0]?.clientY ?? 0;
        const delta = currentY - startY;
        if (delta > 10 && el.scrollTop <= 0) {
          // Prevent native overscroll bounce while pulling
          e.preventDefault();
        }
        if (delta > threshold && !triggered) {
          triggered = true;
          App.refreshData(view);
        }
      };

      const onEnd = () => {
        pulling = false;
        triggered = false;
      };

      el.addEventListener('touchstart', onStart, { passive: true });
      el.addEventListener('touchmove', onMove, { passive: false });
      el.addEventListener('touchend', onEnd, { passive: true });
      el.addEventListener('touchcancel', onEnd, { passive: true });
    };

    addPTR('waypointsList', 'waypoints');
    addPTR('journalList', 'journal');
    addPTR('tripsList', 'trips');
  },

  /**
   * Bind bottom navigation
   */
  bindNavigation() {
    const navBtns = document.querySelectorAll('.nav-btn');
    navBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        this.switchView(view);
      });
    });
  },

  /**
   * Switch between views
   */
  switchView(view) {
    this.currentView = view;
    
    // Update nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    // Hide all panels
    document.querySelectorAll('.panel').forEach(panel => {
      panel.classList.add('hidden');
    });

    // Show selected panel (except map which is always visible)
    if (view !== 'map') {
      const panel = document.getElementById(`${view}Panel`);
      if (panel) {
        panel.classList.remove('hidden');
      }
    }

    // Trigger map resize when switching to map view
    if (view === 'map' && MapManager.map) {
      setTimeout(() => MapManager.map.invalidateSize(), 100);
    }
  },

  /**
   * Bind side menu
   */
  bindMenu() {
    const menuBtn = document.getElementById('menuBtn');
    const closeMenu = document.getElementById('closeMenu');
    const menuOverlay = document.getElementById('menuOverlay');
    const sideMenu = document.getElementById('sideMenu');

    const openMenu = () => {
      sideMenu.classList.remove('hidden');
      menuOverlay.classList.remove('hidden');
    };

    const closeMenuFn = () => {
      sideMenu.classList.add('hidden');
      menuOverlay.classList.add('hidden');
    };

    menuBtn.addEventListener('click', openMenu);
    closeMenu.addEventListener('click', closeMenuFn);
    menuOverlay.addEventListener('click', closeMenuFn);

    // Menu actions
    document.getElementById('newTripBtn').addEventListener('click', () => {
      closeMenuFn();
      App.createNewTrip();
    });

    document.getElementById('importBtn').addEventListener('click', () => {
      closeMenuFn();
      App.importTrip();
    });

    document.getElementById('exportBtn').addEventListener('click', () => {
      closeMenuFn();
      Share.exportJSON();
    });

    document.getElementById('settingsBtn').addEventListener('click', () => {
      closeMenuFn();
      // TODO: Open settings modal
      this.showToast('Settings coming soon', 'info');
    });

    document.getElementById('aboutBtn').addEventListener('click', () => {
      closeMenuFn();
      this.openModal('aboutModal');
    });
  },

  /**
   * Bind modals
   */
  bindModals() {
    // Close buttons
    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal');
        if (modal) {
          this.closeModal(modal.id);
        }
      });
    });

    // Close on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          this.closeModal(modal.id);
        }
      });
    });

    // Add waypoint button
    document.getElementById('addWaypointBtn').addEventListener('click', () => {
      this.openModal('waypointModal');
      MapManager.enableAddWaypointMode();
    });

    // Add note button
    document.getElementById('addNoteBtn').addEventListener('click', () => {
      this.openModal('noteModal');
    });

    // Share button
    document.getElementById('shareBtn').addEventListener('click', () => {
      Share.openShareModal();
    });

    // Ride button
    document.getElementById('rideBtn').addEventListener('click', () => {
      App.enterRideMode();
    });

    // Ride overlay controls moved to App.bindRideControls()
  },

  /**
   * Open modal
   */
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('hidden');
    }
  },

  /**
   * Close modal
   */
  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('hidden');
      
      // Reset forms
      const form = modal.querySelector('form');
      if (form) form.reset();
      
      // Disable waypoint mode if it was the waypoint modal
      if (modalId === 'waypointModal') {
        MapManager.disableAddWaypointMode();
      }
      if (modalId === 'noteModal') {
        const attachmentList = document.getElementById('noteAttachmentList');
        if (attachmentList) attachmentList.innerHTML = '<div class="microcopy">No attachments yet.</div>';
      }
    }
  },

  /**
   * Bind forms
   */
  bindForms() {
    // Waypoint form
    document.getElementById('waypointForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleWaypointSubmit();
    });

    // Note form
    document.getElementById('noteForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleNoteSubmit();
    });
  },

  bindPlaceSearch() {
    const openBtn = document.getElementById('searchPlaceBtn');
    const input = document.getElementById('placeSearchInput');
    const submit = document.getElementById('placeSearchSubmit');
    const resultsEl = document.getElementById('placeSearchResults');
    const statusEl = document.getElementById('placeSearchStatus');
    const useLocationBtn = document.getElementById('placeUseCurrentLocation');

    if (!openBtn || !input || !submit || !resultsEl || !statusEl) return;

    openBtn.addEventListener('click', () => {
      const address = document.getElementById('waypointAddress')?.value || '';
      input.value = address;
      this.placeSearchBias = null;
      this.placeSearchResults = [];
      statusEl.textContent = 'Type a search to begin.';
      resultsEl.innerHTML = '<div class="microcopy">Search returns up to 12 places.</div>';
      this.openModal('placeSearchModal');
      setTimeout(() => input.focus(), 80);
    });

    submit.addEventListener('click', () => this.performPlaceSearch());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.performPlaceSearch();
      }
    });

    if (useLocationBtn) {
      useLocationBtn.addEventListener('click', async () => {
        useLocationBtn.disabled = true;
        statusEl.textContent = 'Getting your location…';
        try {
          const coords = await this.getBrowserLocation();
          this.placeSearchBias = coords;
          statusEl.textContent = 'Location set. Searches will be biased near you.';
        } catch (err) {
          console.error('Geolocation failed', err);
          statusEl.textContent = 'Could not get location. Try again or search without it.';
        } finally {
          useLocationBtn.disabled = false;
        }
      });
    }
  },

  async performPlaceSearch() {
    const input = document.getElementById('placeSearchInput');
    const resultsEl = document.getElementById('placeSearchResults');
    const statusEl = document.getElementById('placeSearchStatus');
    if (!input || !resultsEl || !statusEl) return;

    const query = (input.value || '').trim();
    if (!query) {
      statusEl.textContent = 'Enter a business or landmark name.';
      return;
    }

    const bias = this.placeSearchBias || MapManager.map?.getCenter() || null;
    const options = bias ? { lat: bias.lat, lng: bias.lng } : {};

    statusEl.textContent = 'Searching Google Places…';
    resultsEl.innerHTML = '<div class="microcopy">Searching…</div>';

    try {
      const results = await API.places.search(query, options);
      this.placeSearchResults = results;
      if (!results || results.length === 0) {
        statusEl.textContent = 'No results found. Try another term.';
        resultsEl.innerHTML = '<div class="microcopy">Nothing matched that search.</div>';
        return;
      }
      statusEl.textContent = `Found ${results.length} place${results.length === 1 ? '' : 's'}.`;
      this.renderPlaceResults(results);
    } catch (err) {
      console.error('Place search failed', err);
      statusEl.textContent = 'Search failed. Please try again.';
      resultsEl.innerHTML = '<div class="microcopy error">Search failed.</div>';
    }
  },

  renderPlaceResults(results) {
    const resultsEl = document.getElementById('placeSearchResults');
    if (!resultsEl) return;

    resultsEl.innerHTML = results.map((place, index) => `
      <div class="place-result">
        <div class="place-result-main">
          <div class="place-name">${this.escapeHtml(place.name || 'Unnamed place')}</div>
          ${place.rating ? `<div class="place-rating">★ ${Number(place.rating).toFixed(1)}</div>` : ''}
        </div>
        <div class="place-address">${this.escapeHtml(place.address || '')}</div>
        <div class="place-actions">
          <button type="button" class="secondary-btn" data-use-place="${index}">Use for waypoint</button>
          <button type="button" class="link-btn" data-preview-place="${index}">Show on map</button>
        </div>
      </div>
    `).join('');

    resultsEl.querySelectorAll('[data-use-place]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.usePlace);
        const place = this.placeSearchResults[idx];
        if (place) this.applyPlaceToWaypoint(place);
      });
    });

    resultsEl.querySelectorAll('[data-preview-place]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.previewPlace);
        const place = this.placeSearchResults[idx];
        if (place) this.previewPlaceOnMap(place);
      });
    });
  },

  previewPlaceOnMap(place) {
    if (!place?.location) return;
    const { lat, lng } = place.location;
    MapManager.map?.setView([lat, lng], Math.max(MapManager.map.getZoom() || 12, 14));
    MapManager.showTempLocation(lat, lng);
  },

  applyPlaceToWaypoint(place) {
    if (!place?.location) return;
    const { lat, lng } = place.location;
    const nameEl = document.getElementById('waypointName');
    const addressEl = document.getElementById('waypointAddress');
    const latEl = document.getElementById('waypointLat');
    const lngEl = document.getElementById('waypointLng');

    if (nameEl) nameEl.value = place.name || 'Waypoint';
    if (addressEl) addressEl.value = place.address || '';
    if (latEl) latEl.value = lat;
    if (lngEl) lngEl.value = lng;

    this.closeModal('placeSearchModal');
    this.openModal('waypointModal');
    this.previewPlaceOnMap(place);
    UI.showToast('Place added to waypoint form', 'success');
  },

  getBrowserLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not available'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
  },

  /**
   * Handle waypoint form submit
   */
  handleWaypointSubmit() {
    const name = document.getElementById('waypointName').value.trim();
    const address = document.getElementById('waypointAddress').value.trim();
    const lat = parseFloat(document.getElementById('waypointLat').value);
    const lng = parseFloat(document.getElementById('waypointLng').value);
    const type = document.getElementById('waypointType').value;
    const notes = document.getElementById('waypointNotes').value.trim();

    // Validate coordinates
    if (isNaN(lat) || isNaN(lng)) {
      this.showToast('Please set location by tapping the map or entering coordinates', 'error');
      return;
    }

    App.addWaypoint({ name, address, lat, lng, type, notes });
    this.closeModal('waypointModal');
    this.showToast('Waypoint added', 'success');
  },

  /**
   * Handle note form submit
   */
  handleNoteSubmit() {
    const title = document.getElementById('noteTitle').value.trim();
    const content = document.getElementById('noteContent').value.trim();
    const isPrivate = document.getElementById('notePrivate').checked;
    const tagsStr = document.getElementById('noteTags').value.trim();
    const entryId = document.getElementById('noteEntryId').value.trim();
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];

    if (entryId) {
      App.updateJournalEntry(entryId, { title, content, isPrivate, tags });
    } else {
      App.addJournalEntry({ title, content, isPrivate, tags });
    }
    this.closeModal('noteModal');
    this.showToast(entryId ? 'Note updated' : 'Note added', 'success');
  },

  /**
   * Bind fullscreen toggle
   */
  bindFullscreen() {
    const btn = document.getElementById('fullscreenBtn');
    btn.addEventListener('click', () => {
      this.toggleFullscreen();
    });

    // Update button icon based on fullscreen state
    document.addEventListener('fullscreenchange', () => {
      this.updateFullscreenButton();
    });
  },

  /**
   * Toggle fullscreen mode
   */
  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.log('Fullscreen error:', err);
      });
    } else {
      document.exitFullscreen();
    }
  },

  /**
   * Update fullscreen button icon
   */
  updateFullscreenButton() {
    const btn = document.getElementById('fullscreenBtn');
    if (document.fullscreenElement) {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>';
    } else {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
    }
  },

  /**
   * Update trip title
   */
  updateTripTitle(name) {
    document.getElementById('tripTitle').textContent = name;
  },

  updateTripStats(trip) {
    const el = document.getElementById('tripStats');
    if (!el) return;

    const distance = trip?.route?.distance;
    const time = trip?.route?.time;

    const parts = [];
    if (typeof distance === 'number') parts.push(this.formatDistance(distance));
    if (typeof time === 'number') parts.push(this.formatDuration(time));

    el.innerHTML = parts.length
      ? parts.map((p) => `<span class="trip-stat-pill">${p}</span>`).join('')
      : '';
  },

  formatDistance(meters) {
    if (meters === undefined || meters === null) return '';
    if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
    return `${Math.round(meters)} m`;
  },

  formatDuration(seconds) {
    if (seconds === undefined || seconds === null) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  },

  /**
   * Render waypoints list
   */
  renderWaypoints(waypoints) {
    const container = document.getElementById('waypointsList');
    
    if (waypoints.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
          <h3>No waypoints yet</h3>
          <p>Add your first waypoint to start planning your trip</p>
        </div>
      `;
      return;
    }

    container.innerHTML = waypoints
      .sort((a, b) => a.order - b.order)
      .map((wp, index) => `
        <div class="waypoint-item" data-id="${wp.id}" draggable="true">
          <div class="waypoint-handle" title="Drag to reorder">
            <svg viewBox="0 0 24 24"><path d="M10 4h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2zm4-12h2v2h-2V4zm0 4h2v2h-2V8zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z"/></svg>
          </div>
          <div class="waypoint-icon">
            <span style="font-size: 20px;">${MapManager.waypointIcons[wp.type]?.icon || '📍'}</span>
          </div>
          <div class="waypoint-info">
            <div class="waypoint-name">${index + 1}. ${this.escapeHtml(wp.name)}</div>
            ${wp.address ? `<div class="waypoint-address">${this.escapeHtml(wp.address)}</div>` : ''}
            ${wp.notes ? `<div class="waypoint-notes">${this.escapeHtml(wp.notes)}</div>` : ''}
          </div>
          <div class="waypoint-actions">
            <button class="icon-btn" onclick="MapManager.centerOnWaypoint(App.currentTrip.waypoints.find(w => w.id === '${wp.id}'))" aria-label="Center on map">
              <svg viewBox="0 0 24 24"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>
            </button>
            <button class="icon-btn" onclick="App.deleteWaypoint('${wp.id}')" aria-label="Delete waypoint">
              <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </div>
      `).join('');

    // Drag and drop reordering
    const items = Array.from(container.querySelectorAll('.waypoint-item'));
    let draggingId = null;

    items.forEach((item) => {
      item.addEventListener('dragstart', () => {
        draggingId = item.dataset.id;
        item.classList.add('dragging');
      });

      item.addEventListener('dragenter', (e) => {
        e.preventDefault();
        item.classList.add('drag-over');
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        if (!draggingId) return;
        const targetId = item.dataset.id;
        if (draggingId === targetId) return;

        const orderIds = items.map(el => el.dataset.id);
        const fromIndex = orderIds.indexOf(draggingId);
        const toIndex = orderIds.indexOf(targetId);
        if (fromIndex === -1 || toIndex === -1) return;
        const [moved] = orderIds.splice(fromIndex, 1);
        orderIds.splice(toIndex, 0, moved);

        App.reorderWaypoints(orderIds);
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        draggingId = null;
      });
    });
  },

  /**
   * Render journal entries
   */
  renderJournal(entries) {
    const container = document.getElementById('journalList');
    
    if (entries.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
          <h3>No journal entries yet</h3>
          <p>Add notes about your trip experiences</p>
        </div>
      `;
      return;
    }

    container.innerHTML = entries
      .sort((a, b) => new Date(b.createdAt || b.created_at) - new Date(a.createdAt || a.created_at))
      .map(entry => `
        <div class="journal-entry ${entry.isPrivate ? 'private' : ''}" data-id="${entry.id}">
          <div class="journal-header">
            <div class="journal-title">
              ${entry.isPrivate ? '🔒 ' : ''}${this.escapeHtml(entry.title)}
            </div>
            <div class="journal-date">${this.formatDate(entry.createdAt || entry.created_at)}</div>
          </div>
          <div class="journal-content">${this.escapeHtml(entry.content)}</div>
          ${entry.attachments?.length ? `
            <div class="journal-attachments">
              ${entry.attachments.map(att => `
                <div class="attachment-pill" data-attachment-id="${att.id}">
                  <a href="${att.url}" target="_blank" rel="noopener">${this.escapeHtml(att.original_name || att.filename || att.name || 'Attachment')}</a>
                  <button class="attachment-remove" data-attachment-id="${att.id}" data-entry-id="${entry.id}" aria-label="Remove attachment">×</button>
                </div>
              `).join('')}
            </div>
          ` : ''}
          ${entry.tags?.length > 0 ? `
            <div class="journal-tags">
              ${entry.tags.map(tag => `<span class="tag">${this.escapeHtml(tag)}</span>`).join('')}
            </div>
          ` : ''}
          <div class="journal-actions">
            <button class="icon-btn" onclick="App.pickJournalAttachment('${entry.id}'); event.stopPropagation();" aria-label="Attach file">
              📎
            </button>
            <button class="icon-btn" onclick="App.deleteJournalEntry('${entry.id}'); event.stopPropagation();" aria-label="Delete entry">
              <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </div>
      `).join('');
    
      container.querySelectorAll('.journal-entry').forEach((el) => {
        el.addEventListener('click', () => {
          const id = el.dataset.id;
          if (!id) return;
          App.startEditJournalEntry(id);
        });
      });

      container.querySelectorAll('.attachment-remove').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const attachmentId = btn.dataset.attachmentId;
          const entryId = btn.dataset.entryId;
          if (attachmentId && entryId) {
            App.deleteAttachment(attachmentId, entryId);
          }
        });
      });
  },

  /**
   * Render trips list
   */
  renderTrips(trips, currentTripId) {
    const container = document.getElementById('tripsList');
    
    if (trips.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24"><path d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z"/></svg>
          <h3>No saved trips</h3>
          <p>Your trips will appear here</p>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    const template = document.getElementById('tripItemTemplate');
    const normalizedTrips = trips.map((trip) => ({
      ...trip,
      waypoints: Array.isArray(trip.waypoints) ? trip.waypoints : [],
      journal: Array.isArray(trip.journal) ? trip.journal : [],
    }));

    const total = normalizedTrips.length;

    normalizedTrips.forEach((trip, index) => {
      const stats = Trip.getStats(trip);
      const waypointCount = Number.isFinite(trip.waypoint_count) ? trip.waypoint_count : stats.waypointCount;
      const journalCount = Number.isFinite(trip.journal_count) ? trip.journal_count : stats.journalCount;
      const node = template.content.cloneNode(true);
      const item = node.querySelector('.trip-item');
      item.dataset.id = trip.id;
      if (trip.id === currentTripId) item.classList.add('active');
      item.tabIndex = 0;
      node.querySelector('.trip-name').textContent = this.escapeHtml(trip.name);
      node.querySelector('.trip-meta').innerHTML = `<span>📍 ${waypointCount} waypoints</span> <span>📝 ${journalCount} notes</span>`;
      const statusPill = node.querySelector('.trip-status-pill');
      const copyBtn = node.querySelector('.trip-copy-link');
      const makePublicBtn = node.querySelector('.trip-make-public');

      const link = trip.short_url || (trip.short_code ? `${window.location.origin}/${trip.short_code}` : '');
      if (trip.is_public) {
        statusPill.textContent = 'Public';
        statusPill.className = 'trip-status-pill public';
        copyBtn.style.display = 'inline-flex';
        makePublicBtn.style.display = 'none';
        copyBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!link) {
            UI.showToast('No link yet', 'info');
            return;
          }
          try {
            await navigator.clipboard.writeText(link);
            UI.showToast('Link copied', 'success');
          } catch (err) {
            console.error(err);
            UI.showToast('Copy failed', 'error');
          }
        };
      } else {
        statusPill.textContent = 'Private';
        statusPill.className = 'trip-status-pill private';
        copyBtn.style.display = 'none';
        makePublicBtn.style.display = 'inline-flex';
        makePublicBtn.onclick = (e) => {
          e.stopPropagation();
          App.openTripDetails(trip.id);
        };
      }
      const detailsBtn = node.querySelector('.trip-details-btn');
      if (detailsBtn) {
        detailsBtn.onclick = (e) => { e.stopPropagation(); App.openTripDetails(trip.id); };
      }

      const deleteBtn = node.querySelector('.trip-delete-btn');
      if (deleteBtn) {
        deleteBtn.onclick = (e) => { e.stopPropagation(); this.showDeleteTripConfirm(trip); };
      }

      const moveUp = node.querySelector('.trip-move-up');
      const moveDown = node.querySelector('.trip-move-down');
      if (moveUp) {
        moveUp.disabled = index === 0;
        moveUp.onclick = (e) => { e.stopPropagation(); this.requestTripReorder(trip.id, 'up'); };
      }
      if (moveDown) {
        moveDown.disabled = index === total - 1;
        moveDown.onclick = (e) => { e.stopPropagation(); this.requestTripReorder(trip.id, 'down'); };
      }

      item.addEventListener('click', () => App.loadTrip(trip.id));
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          App.loadTrip(trip.id);
        }
      });
      container.appendChild(node);
    });
  },

  showDeleteTripConfirm(trip) {
    const name = trip.name || 'this trip';
    const ok = window.confirm(`Delete ${name}? This cannot be undone.`);
    if (ok) {
      App.deleteTrip(trip.id);
    }
  },

  requestTripReorder(tripId, direction) {
    App.reorderTrips(tripId, direction);
  },

  /**
   * Show toast notification
   */
  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = type;
    
    // Clear any existing timeout
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }

    // Show toast
    setTimeout(() => {
      toast.classList.remove('hidden');
    }, 10);

    // Hide after delay
    this.toastTimeout = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3000);
  },

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Format date for display
   */
  formatDate(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diff = now - date;
    
    // Less than 24 hours
    if (diff < 86400000) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    // Less than 7 days
    if (diff < 604800000) {
      return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    }
    
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
};

// Make available globally
window.UI = UI;
