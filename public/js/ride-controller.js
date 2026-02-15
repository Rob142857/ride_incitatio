/**
 * Ride Controller — ride mode, GPS tracking, rerouting, metrics
 * Extends App object (loaded after app-core.js)
 */
Object.assign(App, {
  bindRideControls() {
    document.getElementById('rideInfoBtn')?.addEventListener('click', () => {
      document.getElementById('rideStatsPanel')?.classList.toggle('hidden');
    });
    document.getElementById('rideAddBtn')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.remove('hidden');
    });
    document.getElementById('rideAddSheetClose')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.add('hidden');
    });
    document.getElementById('rideAddNoteBtn')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.add('hidden');
      if (!this.ensureEditable('add a note')) return;
      UI.openModal('noteModal');
    });
    document.getElementById('rideAddPhotoBtn')?.addEventListener('click', () => {
      document.getElementById('rideAddSheet')?.classList.add('hidden');
      if (!this.ensureEditable('add a photo')) return;
      document.getElementById('ridePhotoInput')?.click();
    });
    document.getElementById('ridePhotoInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await this.addPhotoAttachment(file);
      e.target.value = '';
    });
    document.getElementById('rideRecenterBtn')?.addEventListener('click', () => {
      MapManager.recenterRide();
    });
    document.getElementById('rideExitBtn')?.addEventListener('click', () => this.exitRideMode());
    document.getElementById('rideBannerExitBtn')?.addEventListener('click', () => this.exitRideMode());
  },

  enterRideMode() {
    if (!this.currentTrip) { UI.showToast('No trip loaded', 'error'); return; }
    if (!this.currentTrip.route?.coordinates) {
      UI.showToast('Add a route first to start riding', 'error'); return;
    }
    this.isRiding = true;
    this.rideVisitedWaypoints = new Set();
    this.rideRerouting = false;
    this.offRouteCounter = 0;
    this.lastRerouteAt = 0;
    document.getElementById('rideOverlay')?.classList.remove('hidden');
    document.body.classList.add('ride-mode');
    document.getElementById('rideTripName').textContent = this.currentTrip.name || 'Ride';
    document.getElementById('rideStops').textContent = (this.currentTrip.waypoints?.length ?? 0).toString();
    document.getElementById('rideDistanceRemaining').textContent = this.currentTrip.route?.distance ? this.formatDistance(this.currentTrip.route.distance) : '—';
    document.getElementById('rideEta').textContent = this.currentTrip.route?.duration ? this.formatDuration(this.currentTrip.route.duration) : '—';
    document.getElementById('rideNextInstruction').textContent = 'Follow the route';
    document.getElementById('rideNextMeta').textContent = 'Waiting for GPS...';
    this.precomputeRouteMetrics();
    this.prefetchTiles();
    MapManager.startRide(pos => this.onRidePosition(pos));
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

  /** @deprecated Use RideUtils.haversine directly */
  haversine(a, b) { return RideUtils.haversine(a, b); },

  prefetchTiles() {
    if (this.currentTrip?.route?.coordinates) {
      MapManager.prefetchTiles(this.currentTrip.route.coordinates);
    }
  },

  markVisitedWaypoints(position) {
    if (!this.currentTrip?.waypoints) return;
    const threshold = 40;
    if (!this.rideVisitedWaypoints) this.rideVisitedWaypoints = new Set();
    this.currentTrip.waypoints.forEach(wp => {
      if (this.rideVisitedWaypoints.has(wp.id)) return;
      if (this.haversine(wp, position) <= threshold) this.rideVisitedWaypoints.add(wp.id);
    });
  },

  getRemainingWaypoints() {
    if (!this.currentTrip?.waypoints) return [];
    if (!this.rideVisitedWaypoints) this.rideVisitedWaypoints = new Set();
    return [...this.currentTrip.waypoints]
      .filter(wp => !this.rideVisitedWaypoints.has(wp.id))
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
    if (stopsEl) stopsEl.textContent = remainingWaypoints.length.toString();

    // Find nearest segment point
    let nearestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = this.haversine(coords[i], pos);
      if (d < bestDist) { bestDist = d; nearestIdx = i; }
    }

    const dynamicThreshold = Math.max(50, (pos.accuracy || 30) * 1.6);
    const now = Date.now();
    if (bestDist > dynamicThreshold) {
      this.offRouteCounter = (this.offRouteCounter || 0) + 1;
    } else {
      this.offRouteCounter = 0;
    }

    const canReroute = bestDist > dynamicThreshold && this.offRouteCounter >= 4
      && !this.rideRerouting && (now - (this.lastRerouteAt || 0) > 45000);
    if (canReroute) {
      this.rideRerouting = true;
      this.lastRerouteAt = now;
      UI.showToast('Off route. Rerouting...', 'info');
      MapManager.rerouteFromPosition(pos, remainingWaypoints);
    }

    const remaining = Math.max(0, total - cumulative[nearestIdx]);
    document.getElementById('rideDistanceRemaining').textContent = RideUtils.formatDistance(remaining);

    const steps = this.currentTrip.route.steps || [];
    const nextStep = steps.find(s => s.index >= nearestIdx) || steps[steps.length - 1];
    if (nextStep) {
      document.getElementById('rideNextInstruction').textContent = nextStep.text || 'Continue';
      const distToNextStep = nextStep.index > nearestIdx
        ? cumulative[nextStep.index] - cumulative[nearestIdx] : bestDist;
      document.getElementById('rideNextMeta').textContent = `${RideUtils.formatDistance(distToNextStep)} ahead`;
    } else {
      document.getElementById('rideNextInstruction').textContent = 'Finish';
      document.getElementById('rideNextMeta').textContent = 'Approaching destination';
    }
  }
});
