/**
 * Trip Controller — trip CRUD, loading, caching, ordering, details modal
 * Extends App object (loaded after app-core.js)
 */
Object.assign(App, {
  /* --- Trip caching & versioning --- */

  markTripWritten(tripId) {
    if (!tripId) return;
    if (!this.tripWriteClock) this.tripWriteClock = {};
    this.tripWriteClock[tripId] = Date.now();
  },

  cacheTripData(trip) {
    if (!trip?.id) return;
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
    if (meta.trip_updated_at) {
      trip.updated_at = meta.trip_updated_at;
      trip.updatedAt = meta.trip_updated_at;
    }
  },

  async handleTripConflict(_err) {
    UI.showToast('Trip changed on another device. Reloading latest…', 'info');
    try { await this.refreshData('conflict'); } catch (_) {}
  },

  /* --- Trip ordering --- */

  applyTripOrder(trips) {
    const normalizedTrips = trips.map(t => this.normalizeTrip(t));
    const order = Storage.getTripOrder() || [];
    const byId = new Map(normalizedTrips.map(t => [t.id, t]));
    const seen = new Set();
    const ordered = [];
    order.forEach(id => {
      const trip = byId.get(id);
      if (trip) { ordered.push(trip); seen.add(id); }
    });
    const remaining = normalizedTrips
      .filter(t => !seen.has(t.id))
      .sort((a, b) => this.getTripSortTimestamp(b) - this.getTripSortTimestamp(a));
    const finalList = [...ordered, ...remaining];
    Storage.setTripOrder(finalList.map(t => t.id));
    return finalList;
  },

  bumpTripToTop(tripId) {
    const order = Storage.getTripOrder().filter(id => id !== tripId);
    Storage.setTripOrder([tripId, ...order]);
  },

  reorderTrips(tripId, direction) {
    if (!this.tripListCache?.length) return;
    const trips = [...this.tripListCache];
    const index = trips.findIndex(t => t.id === tripId);
    if (index === -1) return;
    const target = index + (direction === 'up' ? -1 : 1);
    if (target < 0 || target >= trips.length) return;
    [trips[index], trips[target]] = [trips[target], trips[index]];
    Storage.setTripOrder(trips.map(t => t.id));
    this.tripListCache = trips;
    UI.renderTrips(trips, this.currentTrip?.id);
  },

  /* --- Trip loading & saving --- */

  async loadInitialTrip() {
    if (this.useCloud && this.currentUser) {
      try {
        const trips = await API.trips.list();
        const pendingImportedId = localStorage.getItem('ride_imported_trip_id');
        if (trips.length > 0) {
          const targetId = (pendingImportedId && trips.some(t => t.id === pendingImportedId))
            ? pendingImportedId : trips[0].id;
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
        this._clearTripUI();
      }
    } else {
      this._clearTripUI();
    }
  },

  loadTripData(trip) {
    if (trip.waypoints) trip.waypoints = Trip.normalizeWaypointOrder(trip.waypoints);
    trip = this.normalizeTrip(trip);
    if (!Number.isFinite(Number(trip.version))) trip.version = 0;
    else trip.version = Number(trip.version);
    this.attachJournalAttachments(trip);
    this.currentTrip = trip;
    this.cacheTripData(trip);
    UI.updateTripTitle(trip.name);
    UI.updateTripStats(trip);
    UI.renderWaypoints(trip.waypoints || []);
    UI.renderJournal(trip.journal || []);
    MapManager.clear();
    MapManager.updateWaypoints(trip.waypoints || []);
    if (trip.waypoints?.length > 0) MapManager.fitToWaypoints(trip.waypoints);
  },

  loadTripDataIfCurrent(trip) {
    const normalized = this.normalizeTrip(trip);
    if (this.currentTrip?.id === normalized?.id) this.loadTripData(normalized);
  },

  attachJournalAttachments(trip) {
    if (!trip) return;
    const attachments = Array.isArray(trip.attachments) ? trip.attachments : [];
    const byEntry = new Map();
    attachments.forEach(att => {
      const entryId = att.journal_entry_id || att.journalEntryId;
      if (!entryId) return;
      if (!byEntry.has(entryId)) byEntry.set(entryId, []);
      byEntry.get(entryId).push(att);
    });
    trip.journal = (trip.journal || []).map(entry => ({
      ...entry,
      attachments: byEntry.get(entry.id) || entry.attachments || []
    }));
    trip.attachments = attachments;
  },

  /**
   * Load a trip by ID. Simplified stale-read guard: trust version numbers.
   */
  async loadTrip(tripId) {
    if (!this.useCloud || !this.currentUser) return;
    try {
      const trip = this.normalizeTrip(await API.trips.get(tripId));
      const cached = this.getCachedTrip(tripId);
      const serverV = Number(trip?.version);
      const cachedV = Number(cached?.version);

      // If server returned an older version than what we have cached, keep cache and retry once
      if (cached && Number.isFinite(serverV) && Number.isFinite(cachedV) && serverV < cachedV) {
        console.warn('loadTrip: stale read detected, keeping cache', { tripId, serverV, cachedV });
        this.loadTripData(cached);
        this.refreshTripsList();
        UI.switchView('map');
        UI.showToast(`Loaded: ${cached.name}`, 'success');
        setTimeout(async () => {
          try {
            if (!this.useCloud || !this.currentUser || this.currentTrip?.id !== tripId) return;
            const retry = this.normalizeTrip(await API.trips.get(tripId));
            if (Number(retry?.version) >= cachedV) this.loadTripData(retry);
          } catch (_) {}
        }, 1500);
        return;
      }

      this.loadTripData(trip);
      this.refreshTripsList();
      UI.switchView('map');
      UI.showToast(`Loaded: ${trip.name}`, 'success');
    } catch (error) {
      console.error('Failed to load cloud trip:', error);
      UI.showToast('Unable to load trip from server.', 'error');
    }
  },

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
        UI.showToast('Login required to create trips.', 'error');
        return;
      }
    }
    UI.showToast('Login to create and save trips.', 'error');
  },

  async saveCurrentTrip() {
    if (!this.currentTrip) return false;
    if (!this.useCloud || !this.currentUser) return false;
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
        cover_image_url: this.currentTrip.coverImageUrl || this.currentTrip.cover_image_url,
        cover_focus_x: this.currentTrip.coverFocusX ?? this.currentTrip.cover_focus_x,
        cover_focus_y: this.currentTrip.coverFocusY ?? this.currentTrip.cover_focus_y
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
      if (error.status === 409) { await this.handleTripConflict(error); return false; }
      if (error.status === 404) {
        UI.showToast('Trip missing on server. Reloading your trips…', 'error');
        await this.loadInitialTrip();
      } else {
        UI.showToast('Save failed. Not saved to cloud.', 'error');
      }
      return false;
    }
  },

  async deleteTrip(tripId) {
    if (this.useCloud && this.currentUser) {
      try { await API.trips.delete(tripId); } catch (error) { console.error('Failed to delete trip:', error); }
    }
    Storage.setTripOrder(Storage.getTripOrder().filter(id => id !== tripId));
    this.tripListCache = (this.tripListCache || []).filter(t => t.id !== tripId);
    if (this.currentTrip?.id === tripId) await this.loadInitialTrip();
    this.refreshTripsList();
    UI.showToast('Trip deleted', 'success');
  },

  /* --- Refresh (simplified stale-read) --- */

  _refreshTripsTimer: null,
  _refreshTripsResolvers: [],

  /**
   * Debounced refreshTripsList — coalesces rapid successive calls
   * into a single API request after 400ms of quiet.
   */
  refreshTripsList() {
    return new Promise((resolve) => {
      this._refreshTripsResolvers.push(resolve);
      clearTimeout(this._refreshTripsTimer);
      this._refreshTripsTimer = setTimeout(() => this._doRefreshTripsList(), 400);
    });
  },

  async _doRefreshTripsList() {
    const resolvers = this._refreshTripsResolvers.splice(0);
    const finish = () => resolvers.forEach(r => r());
    if (!this.useCloud || !this.currentUser) {
      Storage.setTripOrder([]);
      this.tripListCache = [];
      UI.renderTrips([], this.currentTrip?.id);
      finish(); return;
    }
    try {
      const trips = await API.trips.list();
      const currentId = this.currentTrip?.id;
      if (!trips.length) {
        Storage.setTripOrder([]);
        this.tripListCache = [];
        UI.renderTrips([], currentId);
        finish(); return;
      }
      const orderedTrips = this.applyTripOrder(trips);
      this.tripListCache = orderedTrips;
      UI.renderTrips(orderedTrips, currentId);
    } catch (error) {
      console.error('Failed to load trips list:', error);
      UI.showToast('Unable to load trips from server.', 'error');
    }
    finish();
  },

  /**
   * Refresh current trip and list. Simplified: trust version numbers only.
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
      const orderedTrips = this.applyTripOrder(trips);
      this.tripListCache = orderedTrips;

      const currentId = this.currentTrip?.id;
      const currentExists = currentId ? orderedTrips.some(t => t.id === currentId) : false;
      const fallbackId = orderedTrips[0]?.id ?? null;
      const targetId = currentExists ? currentId : fallbackId;
      UI.renderTrips(orderedTrips, targetId);

      if (!targetId) {
        this._clearTripUI();
        UI.showToast('No trips available to refresh.', 'info');
        return;
      }

      const loadFresh = async (id) => {
        try { return this.normalizeTrip(await API.trips.get(id)); }
        catch (err) { if (err.status === 404) return null; throw err; }
      };

      let fresh = await loadFresh(targetId);
      if (!fresh && fallbackId && fallbackId !== targetId) fresh = await loadFresh(fallbackId);
      if (!fresh) {
        this._clearTripUI();
        UI.showToast('Trip not found. Please try again.', 'error');
        return;
      }

      // Simple stale-read guard: if server version < local version, retry once
      const serverV = Number(fresh.version);
      const localV = Number(this.currentTrip?.version);
      if (source === 'visibility' && Number.isFinite(serverV) && Number.isFinite(localV) && serverV < localV) {
        console.warn('refreshData: stale read, retrying', { serverV, localV });
        setTimeout(async () => {
          try {
            if (!this.useCloud || !this.currentUser || this.currentTrip?.id !== fresh.id) return;
            const retry = await loadFresh(fresh.id);
            if (!retry) return;
            if (Number(retry.version) >= Number(this.currentTrip?.version)) this.loadTripData(retry);
          } catch (_) {}
        }, 1500);
        return;
      }

      this.loadTripData(fresh);
      UI.showToast('Latest data loaded', 'success');
    } catch (error) {
      console.error('Refresh failed:', error);
      UI.showToast('Refresh failed. Please try again.', 'error');
    } finally {
      this.isRefreshing = false;
    }
  },

  /* --- Trip details modal --- */

  async openTripDetails(tripId) {
    try {
      if (!this.useCloud || !this.currentUser) {
        UI.showToast('Login to view trip details.', 'error');
        return;
      }
      const trip = await API.trips.get(tripId);
      if (!trip) { UI.showToast('Trip not found', 'error'); return; }
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
    if (coverInput) coverInput.value = trip.coverImageUrl || trip.cover_image_url || '';
    const focusXInput = document.getElementById('tripDetailCoverFocusX');
    const focusYInput = document.getElementById('tripDetailCoverFocusY');
    if (focusXInput) focusXInput.value = Number.isFinite(trip.coverFocusX) ? trip.coverFocusX : (Number.isFinite(trip.cover_focus_x) ? trip.cover_focus_x : 50);
    if (focusYInput) focusYInput.value = Number.isFinite(trip.coverFocusY) ? trip.coverFocusY : (Number.isFinite(trip.cover_focus_y) ? trip.cover_focus_y : 50);
    const coverFileName = document.getElementById('tripDetailCoverFileName');
    if (coverFileName) coverFileName.textContent = '';
    document.getElementById('tripDetailPublic').checked = !!(trip.isPublic ?? trip.is_public);
    const linkInput = document.getElementById('tripDetailLink');
    const link = trip.shortUrl || trip.short_url || ((trip.shortCode || trip.short_code) ? `${window.location.origin}/${trip.shortCode || trip.short_code}` : '');
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
    if (!tripId) { UI.showToast('No trip selected', 'error'); return; }
    if (!name) { UI.showToast('Name is required', 'error'); return; }

    try {
      if (coverFile && (!this.useCloud || !this.currentUser)) {
        UI.showToast('Sign in to upload a cover image', 'error'); return;
      }
      if (coverFile) {
        UI.showToast('Uploading cover image...', 'info');
        const attachment = await API.attachments.upload(tripId, coverFile, { is_cover: true });
        coverImageUrl = attachment.url;
        if (coverInput) { coverInput.value = coverImageUrl; this.updateCoverFocusUI(); }
      }
      if (!this.useCloud || !this.currentUser) {
        UI.showToast('Login to update trips.', 'error'); return;
      }
      await API.trips.update(tripId, { name, description, is_public: isPublic, cover_image_url: coverImageUrl || null, cover_focus_x: coverFocusX, cover_focus_y: coverFocusY });
      let updatedTrip;
      if (isPublic) {
        const share = await API.trips.share(tripId);
        updatedTrip = await API.trips.get(tripId);
        updatedTrip.shortUrl = share.shareUrl;
        updatedTrip.short_url = share.shareUrl;
        updatedTrip.shortCode = share.shortCode;
        updatedTrip.short_code = share.shortCode;
      } else {
        updatedTrip = await API.trips.get(tripId);
      }
      updatedTrip = this.normalizeTrip(updatedTrip);
      updatedTrip.coverFocusX = coverFocusX;
      updatedTrip.cover_focus_x = coverFocusX;
      updatedTrip.coverFocusY = coverFocusY;
      updatedTrip.cover_focus_y = coverFocusY;
      if (this.currentTrip?.id === updatedTrip.id) {
        this.currentTrip = { ...this.currentTrip, ...updatedTrip };
        this.loadTripData(this.currentTrip);
      }
      this.refreshTripsList();
      this.fillTripDetailsForm(updatedTrip);
      if (coverFileInput) {
        coverFileInput.value = '';
        const fn = document.getElementById('tripDetailCoverFileName');
        if (fn) fn.textContent = '';
      }
      UI.showToast('Trip updated', 'success');
      UI.closeModal('tripDetailsModal');
    } catch (err) {
      console.error('Save trip details failed:', err);
      UI.showToast('Failed to save trip', 'error');
    }
  },

  generateTripLink() {
    // Auto-generation now handled during save when public
  }
});
