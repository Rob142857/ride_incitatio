/**
 * Journal Controller — journal entries, attachments, photo capture
 * Extends App object (loaded after app-core.js)
 */
Object.assign(App, {
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
    const entry = (this.currentTrip.journal || []).find(e => e.id === entryId);
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
    listEl.innerHTML = attachments.map(att => {
      const name = UI.escapeHtml(att.original_name || att.filename || att.name || 'Attachment');
      return `
        <div class="attachment-pill" data-attachment-id="${att.id}">
          <a href="${att.url}" target="_blank" rel="noopener">${name}</a>
          <button type="button" class="attachment-remove" data-attachment-id="${att.id}" data-entry-id="${entry.id}" aria-label="Remove attachment">×</button>
        </div>`;
    }).join('');
    listEl.querySelectorAll('.attachment-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation(); e.preventDefault();
        const attachmentId = btn.dataset.attachmentId;
        const entryId = btn.dataset.entryId;
        if (attachmentId && entryId) this.deleteAttachment(attachmentId, entryId);
      });
    });
  },

  async addJournalEntry(data) {
    if (!this.currentTrip || !this.ensureEditable('add notes')) return null;
    let entry;
    try {
      entry = await API.journal.add(this.currentTrip.id, {
        title: data.title, content: data.content,
        is_private: data.isPrivate, tags: data.tags
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
    if (!this.currentTrip || !this.ensureEditable('update notes')) return null;
    let updated;
    try {
      updated = await API.journal.update(this.currentTrip.id, entryId, {
        title: data.title, content: data.content,
        is_private: data.isPrivate, tags: data.tags
      });
    } catch (error) {
      console.error('Failed to update journal entry:', error);
      UI.showToast('Note not updated in cloud.', 'error');
      return null;
    }
    if (updated) {
      const idx = this.currentTrip.journal.findIndex(e => e.id === entryId);
      if (idx >= 0) {
        const existing = this.currentTrip.journal[idx];
        this.currentTrip.journal[idx] = { ...updated, attachments: existing?.attachments || [] };
      }
    }
    UI.renderJournal(this.currentTrip.journal);
    return updated;
  },

  async deleteJournalEntry(entryId) {
    if (!this.currentTrip || !this.ensureEditable('delete notes')) return;
    try { await API.journal.delete(this.currentTrip.id, entryId); }
    catch (error) {
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
    if (!this.currentTrip || !this.ensureEditable('upload attachments')) return;
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
    const entry = (this.currentTrip.journal || []).find(e => e.id === entryId);
    if (entry) this.renderNoteAttachments(entry);
  },

  addAttachmentToEntry(entryId, attachment, prepend = false) {
    if (!this.currentTrip) return;
    if (!this.currentTrip.attachments) this.currentTrip.attachments = [];
    if (!this.currentTrip.attachments.some(a => a.id === attachment.id)) {
      if (prepend) this.currentTrip.attachments.unshift(attachment);
      else this.currentTrip.attachments.push(attachment);
    }
    const entry = (this.currentTrip.journal || []).find(e => e.id === entryId);
    if (!entry) return;
    if (!entry.attachments) entry.attachments = [];
    if (!entry.attachments.some(a => a.id === attachment.id)) {
      if (prepend) entry.attachments.unshift(attachment);
      else entry.attachments.push(attachment);
    }
  },

  removeAttachmentFromState(attachmentId) {
    if (!this.currentTrip) return;
    if (Array.isArray(this.currentTrip.attachments)) {
      this.currentTrip.attachments = this.currentTrip.attachments.filter(a => a.id !== attachmentId);
    }
    if (Array.isArray(this.currentTrip.journal)) {
      this.currentTrip.journal.forEach(entry => {
        if (Array.isArray(entry.attachments)) {
          entry.attachments = entry.attachments.filter(a => a.id !== attachmentId);
        }
      });
    }
  },

  async deleteAttachment(attachmentId, entryId) {
    if (!this.currentTrip || !this.ensureEditable('remove attachments')) return;
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
      const entry = (this.currentTrip.journal || []).find(e => e.id === entryId);
      if (entry) this.renderNoteAttachments(entry);
    }
    // Refresh waypoint details if open
    const wpModal = document.getElementById('waypointDetailsModal');
    if (wpModal && !wpModal.classList.contains('hidden')) {
      const waypointId = document.getElementById('waypointDetailId')?.value || '';
      if (waypointId) this.renderWaypointAttachments(waypointId);
    }
  },

  async addPhotoAttachment(file) {
    if (!this.currentTrip || !this.ensureEditable('save photos')) return;
    const title = `Photo ${new Date().toLocaleString()}`;
    let entry;
    try {
      entry = await API.journal.add(this.currentTrip.id, {
        title, content: '', is_private: false, tags: []
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

  async saveRouteData(routeData) {
    if (!this.currentTrip || !this.ensureEditable('save routes')) return;
    const duration = routeData?.duration ?? routeData?.time ?? null;
    this.currentTrip.route = {
      ...routeData, duration, time: duration,
      coordinates: routeData?.coordinates || []
    };
    this.precomputeRouteMetrics();
    this.prefetchTiles();
    this.rideRerouting = false;
    this.offRouteCounter = 0;

    UI.updateTripStats(this.currentTrip);
    const ok = await this.saveCurrentTrip();
    if (ok) {
      this.markTripWritten(this.currentTrip.id);
      UI.showToast('New route saved', 'success');
      await this.refreshTripsList();
    } else {
      UI.showToast('Route not saved', 'error');
    }
  }
});
