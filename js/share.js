/**
 * Share module - handles sharing and export functionality
 */
const Share = {
  /**
   * Open share modal and generate link
   */
  openShareModal() {
    if (!App.currentTrip) {
      UI.showToast('No trip to share', 'error');
      return;
    }

    // Generate share ID if needed
    Trip.generateShareId(App.currentTrip);
    App.saveCurrentTrip();

    // Generate shareable link
    const shareId = App.currentTrip.shareSettings.shareId;
    const baseUrl = window.location.origin + window.location.pathname;
    const shareUrl = `${baseUrl}?trip=${shareId}`;
    
    document.getElementById('shareLink').value = shareUrl;
    UI.openModal('shareModal');
    
    this.bindShareModalEvents();
  },

  /**
   * Bind share modal events
   */
  bindShareModalEvents() {
    // Copy link button
    document.getElementById('copyLinkBtn').onclick = () => {
      this.copyToClipboard(document.getElementById('shareLink').value);
    };

    // Native share
    document.getElementById('shareNativeBtn').onclick = () => {
      this.nativeShare();
    };

    // Export buttons
    document.getElementById('exportJsonBtn').onclick = () => {
      this.exportJSON();
    };

    document.getElementById('exportGpxBtn').onclick = () => {
      this.exportGPX();
    };
  },

  /**
   * Copy text to clipboard
   */
  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      UI.showToast('Link copied to clipboard', 'success');
    } catch (err) {
      // Fallback for older browsers
      const input = document.createElement('input');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      UI.showToast('Link copied to clipboard', 'success');
    }
  },

  /**
   * Use native share API
   */
  async nativeShare() {
    if (!navigator.share) {
      UI.showToast('Share not supported on this device', 'error');
      return;
    }

    const trip = App.currentTrip;
    const shareUrl = document.getElementById('shareLink').value;
    
    const includeWaypoints = document.getElementById('shareWaypoints').checked;
    const includeRoute = document.getElementById('shareRoute').checked;
    const includeNotes = document.getElementById('sharePublicNotes').checked;

    // Create share data
    const shareData = Trip.getShareableData(trip, {
      includeWaypoints,
      includeRoute,
      includePublicNotes: includeNotes
    });

    let shareText = `Check out my trip: ${trip.name}`;
    if (shareData.stats.waypointCount > 0) {
      shareText += `\n📍 ${shareData.stats.waypointCount} waypoints`;
    }
    if (shareData.stats.publicNotesCount > 0) {
      shareText += `\n📝 ${shareData.stats.publicNotesCount} notes`;
    }

    try {
      await navigator.share({
        title: trip.name,
        text: shareText,
        url: shareUrl
      });
      UI.showToast('Shared successfully', 'success');
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Share failed:', err);
      }
    }
  },

  /**
   * Export trip as JSON
   */
  exportJSON() {
    if (!App.currentTrip) {
      UI.showToast('No trip to export', 'error');
      return;
    }

    const includeWaypoints = document.getElementById('shareWaypoints')?.checked ?? true;
    const includeRoute = document.getElementById('shareRoute')?.checked ?? true;
    const includeNotes = document.getElementById('sharePublicNotes')?.checked ?? true;

    const data = Trip.getShareableData(App.currentTrip, {
      includeWaypoints,
      includeRoute,
      includePublicNotes: includeNotes
    });

    const json = JSON.stringify(data, null, 2);
    this.downloadFile(json, `${App.currentTrip.name.replace(/[^a-z0-9]/gi, '_')}.json`, 'application/json');
    UI.showToast('Trip exported as JSON', 'success');
  },

  /**
   * Export trip as GPX
   */
  exportGPX() {
    if (!App.currentTrip) {
      UI.showToast('No trip to export', 'error');
      return;
    }

    const gpx = Trip.toGPX(App.currentTrip);
    this.downloadFile(gpx, `${App.currentTrip.name.replace(/[^a-z0-9]/gi, '_')}.gpx`, 'application/gpx+xml');
    UI.showToast('Trip exported as GPX', 'success');
  },

  /**
   * Download file
   */
  downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Import trip from file
   */
  importFromFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.gpx';
      
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) {
          reject(new Error('No file selected'));
          return;
        }

        try {
          const content = await file.text();
          let trip;

          if (file.name.endsWith('.gpx')) {
            trip = Trip.fromGPX(content, file.name.replace('.gpx', ''));
          } else {
            const data = JSON.parse(content);
            trip = this.importFromJSON(data);
          }

          resolve(trip);
        } catch (err) {
          reject(err);
        }
      };

      input.click();
    });
  },

  /**
   * Import trip from JSON data
   */
  importFromJSON(data) {
    // Handle both full trip export and shareable export
    const trip = Trip.create(data.name || 'Imported Trip');
    
    if (data.description) trip.description = data.description;
    if (data.waypoints) trip.waypoints = data.waypoints;
    if (data.route) trip.route = data.route;
    if (data.customRoutePoints) trip.customRoutePoints = data.customRoutePoints;
    if (data.journal) trip.journal = data.journal;
    
    // Generate new IDs to avoid conflicts
    trip.id = Storage.generateId();
    trip.waypoints.forEach(wp => wp.id = Storage.generateId());
    trip.journal.forEach(entry => entry.id = Storage.generateId());
    
    return trip;
  },

  /**
   * Load shared trip from URL
   */
  loadSharedTrip(shareId) {
    // In a real app, this would fetch from a server
    // For this demo, we check localStorage for any trip with this share ID
    const trips = Storage.getTrips();
    const trip = trips.find(t => t.shareSettings?.shareId === shareId);
    
    if (trip) {
      // Return public version
      return Trip.getShareableData(trip, {
        includeWaypoints: true,
        includeRoute: true,
        includePublicNotes: true
      });
    }
    
    return null;
  },

  /**
   * Generate embeddable URL for notes apps
   */
  getEmbedUrl(trip) {
    if (!trip.shareSettings.shareId) {
      Trip.generateShareId(trip);
    }
    
    const baseUrl = window.location.origin + window.location.pathname;
    return `${baseUrl}?trip=${trip.shareSettings.shareId}&embed=true`;
  },

  /**
   * Generate markdown link for notes apps
   */
  getMarkdownLink(trip) {
    const url = this.getEmbedUrl(trip);
    return `[${trip.name}](${url})`;
  }
};

// Make available globally
window.Share = Share;
