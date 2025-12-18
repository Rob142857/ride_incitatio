/**
 * UI module - handles DOM interactions and rendering
 */
const UI = {
  currentView: 'map',
  toastTimeout: null,

  /**
   * Initialize UI
   */
  init() {
    this.bindNavigation();
    this.bindMenu();
    this.bindModals();
    this.bindForms();
    this.bindFullscreen();
    return this;
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
      this.showToast('Ride Trip Planner v1.0 • Made in Australia 🇦🇺', 'info');
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
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];

    App.addJournalEntry({ title, content, isPrivate, tags });
    this.closeModal('noteModal');
    this.showToast('Note added', 'success');
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
        <div class="waypoint-item" data-id="${wp.id}">
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
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(entry => `
        <div class="journal-entry ${entry.isPrivate ? 'private' : ''}" data-id="${entry.id}">
          <div class="journal-header">
            <div class="journal-title">
              ${entry.isPrivate ? '🔒 ' : ''}${this.escapeHtml(entry.title)}
            </div>
            <div class="journal-date">${this.formatDate(entry.createdAt)}</div>
          </div>
          <div class="journal-content">${this.escapeHtml(entry.content)}</div>
          ${entry.tags.length > 0 ? `
            <div class="journal-tags">
              ${entry.tags.map(tag => `<span class="tag">${this.escapeHtml(tag)}</span>`).join('')}
            </div>
          ` : ''}
          <div class="journal-actions">
            <button class="icon-btn" onclick="App.deleteJournalEntry('${entry.id}')" aria-label="Delete entry">
              <svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </div>
      `).join('');
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
    trips.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).forEach(trip => {
      const stats = Trip.getStats(trip);
      const node = template.content.cloneNode(true);
      const item = node.querySelector('.trip-item');
      item.dataset.id = trip.id;
      if (trip.id === currentTripId) item.classList.add('active');
      node.querySelector('.trip-name').textContent = this.escapeHtml(trip.name);
      node.querySelector('.trip-meta').innerHTML = `<span>📍 ${stats.waypointCount} waypoints</span> <span>📝 ${stats.journalCount} notes</span>`;
      const toggle = node.querySelector('.public-toggle-checkbox');
      toggle.checked = !!trip.is_public;
      toggle.onchange = (e) => {
        App.setTripPublic(trip.id, e.target.checked);
      };
      container.appendChild(node);
    });
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
