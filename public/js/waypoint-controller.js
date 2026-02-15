/**
 * Waypoint Controller — add, move, delete, reorder waypoints
 * Extends App object (loaded after app-core.js)
 */
Object.assign(App, {
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
        if (!id) { UI.showToast('Open a waypoint first', 'info'); return; }
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
    const wp = (this.currentTrip.waypoints || []).find(w => w.id === waypointId);
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
    const attachments = all.filter(a => a && (a.waypointId === waypointId || a.waypoint_id === waypointId));
    if (!attachments.length) {
      listEl.innerHTML = '<div class="microcopy">No attachments yet.</div>';
      return;
    }
    listEl.innerHTML = attachments.map(att => {
      const name = UI.escapeHtml(att.original_name || att.filename || att.name || 'Attachment');
      return `
        <div class="attachment-pill" data-attachment-id="${att.id}">
          <a href="${att.url}" target="_blank" rel="noopener">${name}</a>
          <button type="button" class="attachment-remove" data-attachment-id="${att.id}" aria-label="Remove attachment">×</button>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
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
        name: data.name, notes: data.notes
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
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return; }
      UI.showToast('Waypoint update failed. Not saved.', 'error');
    }
  },

  async uploadWaypointAttachment(waypointId, file) {
    if (!this.currentTrip || !this.ensureEditable('upload attachments')) return;
    try {
      UI.showToast('Uploading attachment...', 'info');
      const attachment = await API.attachments.upload(this.currentTrip.id, file, {
        waypoint_id: waypointId, is_private: false, headers: this.getTripIfMatchHeaders()
      });
      if (!this.currentTrip.attachments) this.currentTrip.attachments = [];
      if (!this.currentTrip.attachments.some(a => a.id === attachment.id)) {
        this.currentTrip.attachments.unshift(attachment);
      }
      UI.showToast('Attachment uploaded', 'success');
      this.renderWaypointAttachments(waypointId);
    } catch (err) {
      console.error('Waypoint attachment upload failed', err);
      if (err.status === 409 || err.status === 428) { await this.handleTripConflict(err); return; }
      UI.showToast('Attachment upload failed', 'error');
    }
  },

  async addWaypoint(data) {
    if (!this.currentTrip || !this.ensureEditable('add waypoints')) return null;
    let waypoint;
    try {
      const res = await API.waypoints.add(this.currentTrip.id, data, { headers: this.getTripIfMatchHeaders() });
      waypoint = res.waypoint;
      this.applyTripMetaFromResponse(this.currentTrip, res);
      if (!this.currentTrip.waypoints) this.currentTrip.waypoints = [];
      this.currentTrip.waypoints.push(waypoint);
      this.currentTrip.waypoints = Trip.normalizeWaypointOrder(this.currentTrip.waypoints);
      if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') this.currentTrip.settings = {};
      this.currentTrip.settings.waypoint_order = this.currentTrip.waypoints.map(w => w.id);
      this.markTripWritten(this.currentTrip.id);
    } catch (error) {
      console.error('Failed to add waypoint to cloud:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return null; }
      UI.showToast('Could not add waypoint (not saved)', 'error');
      return null;
    }
    UI.renderWaypoints(this.currentTrip.waypoints);
    MapManager.addWaypointMarker(waypoint);
    await this.refreshTripsList();
    UI.showToast('Waypoint saved', 'success');
    if (this.currentTrip.waypoints.length >= 2) MapManager.updateRoute(this.currentTrip.waypoints);
    return waypoint;
  },

  async updateWaypointPosition(waypointId, lat, lng) {
    if (!this.currentTrip || !this.ensureEditable('move waypoints')) return;
    try {
      const res = await API.waypoints.update(this.currentTrip.id, waypointId, { lat, lng }, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
      if (res?.waypoint) {
        Trip.updateWaypoint(this.currentTrip, waypointId, res.waypoint);
        this.currentTrip.waypoints = Trip.normalizeWaypointOrder(this.currentTrip.waypoints);
      }
    } catch (error) {
      console.error('Failed to update waypoint:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return; }
      UI.showToast('Move failed. Not saved to cloud.', 'error');
      return;
    }
    if (!this.currentTrip.waypoints?.some(w => w.id === waypointId && w.lat === lat && w.lng === lng)) {
      Trip.updateWaypoint(this.currentTrip, waypointId, { lat, lng });
    }
    this.markTripWritten(this.currentTrip.id);
    const now = Date.now();
    if (now - (this.waypointSaveToastAt || 0) > 2500) {
      this.waypointSaveToastAt = now;
      UI.showToast('Waypoint saved', 'success');
    }
    if (this.currentTrip.waypoints.length >= 2) MapManager.updateRoute(this.currentTrip.waypoints);
    UI.renderWaypoints(this.currentTrip.waypoints);
    await this.refreshTripsList();
  },

  async deleteWaypoint(waypointId) {
    if (!this.currentTrip || !this.ensureEditable('delete waypoints')) return;
    try {
      const res = await API.waypoints.delete(this.currentTrip.id, waypointId, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
    } catch (error) {
      console.error('Failed to delete waypoint:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return; }
    }
    Trip.removeWaypoint(this.currentTrip, waypointId);
    if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') this.currentTrip.settings = {};
    this.currentTrip.settings.waypoint_order = (this.currentTrip.waypoints || []).map(w => w.id);
    this.markTripWritten(this.currentTrip.id);
    MapManager.removeWaypointMarker(waypointId);
    UI.renderWaypoints(this.currentTrip.waypoints);
    if (this.currentTrip.waypoints.length >= 2) MapManager.updateRoute(this.currentTrip.waypoints);
    else MapManager.clearRoute();
    UI.showToast('Waypoint deleted', 'success');
    await this.refreshTripsList();
  },

  async reorderWaypoints(orderIds) {
    if (!this.currentTrip || !this.ensureEditable('reorder waypoints')) return;
    if (this.isReorderingWaypoints) return;
    this.isReorderingWaypoints = true;
    this.setWaypointsSaving(true);
    try {
      Trip.reorderWaypoints(this.currentTrip, orderIds);
      const res = await API.waypoints.reorder(this.currentTrip.id, orderIds, { headers: this.getTripIfMatchHeaders() });
      this.applyTripMetaFromResponse(this.currentTrip, res);
      if (!this.currentTrip.settings || typeof this.currentTrip.settings !== 'object') this.currentTrip.settings = {};
      this.currentTrip.settings.waypoint_order = Array.isArray(orderIds) ? orderIds.slice() : [];
      this.markTripWritten(this.currentTrip.id);
      UI.renderWaypoints(this.currentTrip.waypoints);
      MapManager.updateWaypoints(this.currentTrip.waypoints);
      await this.refreshTripsList();
      UI.showToast('Waypoint order saved', 'success');
    } catch (error) {
      console.error('Failed to reorder waypoints:', error);
      if (error.status === 409 || error.status === 428) { await this.handleTripConflict(error); return; }
      UI.showToast('Reorder failed. Not saved to cloud.', 'error');
    } finally {
      this.setWaypointsSaving(false);
      this.isReorderingWaypoints = false;
    }
  },

  setWaypointsSaving(isSaving) {
    const list = document.getElementById('waypointsList');
    if (!list) return;
    list.classList.toggle('is-saving', !!isSaving);
    list.setAttribute('aria-busy', isSaving ? 'true' : 'false');
    list.classList.add('waypoints-list');
  }
});
