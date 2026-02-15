/**
 * Auth Controller — login/logout, session management, auth UI
 * Uses a state machine: UNKNOWN → CHECKING → AUTHENTICATED | UNAUTHENTICATED | ERROR
 * All UI side effects are driven by _setAuthState transitions.
 * Extends App object (loaded after app-core.js)
 */
Object.assign(App, {
  /** @type {'UNKNOWN'|'CHECKING'|'AUTHENTICATED'|'UNAUTHENTICATED'|'ERROR'} */
  _authState: 'UNKNOWN',

  /**
   * Central state transition — drives all auth-related UI.
   * @param {'CHECKING'|'AUTHENTICATED'|'UNAUTHENTICATED'|'ERROR'} state
   * @param {string} [reason] Human-readable reason for the transition
   */
  _setAuthState(state, reason = '') {
    const prev = this._authState;
    if (prev === state && state !== 'CHECKING') return; // no-op for same state (allow re-CHECKING)
    this._authState = state;
    console.debug(`[auth] ${prev} → ${state}${reason ? ': ' + reason : ''}`);

    switch (state) {
      case 'CHECKING':
        // No UI change while checking
        break;

      case 'AUTHENTICATED':
        this.updateUserUI();
        UI.hideAuthGate();
        UI.closeModal('loginModal');
        break;

      case 'UNAUTHENTICATED':
        this.currentUser = null;
        this.useCloud = false;
        localStorage.removeItem('ride_last_user_id');
        this.updateUserUI();
        if (prev === 'AUTHENTICATED') {
          // Was logged in, now logged out — clear trip state
          this._clearTripUI();
        }
        if (reason) UI.showToast(reason, prev === 'AUTHENTICATED' ? 'error' : 'info');
        if (!this.isSharedView && !UI.isLandingGateVisible()) {
          UI.closeModal('loginModal');
          UI.showAuthGate(reason || 'Signed out');
        }
        break;

      case 'ERROR':
        this.currentUser = null;
        this.useCloud = false;
        localStorage.removeItem('ride_last_user_id');
        this.updateUserUI();
        if (prev === 'AUTHENTICATED') this._clearTripUI();
        if (reason) UI.showToast(reason, 'error');
        if (!this.isSharedView && !UI.isLandingGateVisible()) {
          UI.showAuthGate(reason || 'Auth error');
        }
        break;
    }
  },

  async checkAuth() {
    this._setAuthState('CHECKING');
    try {
      const user = await API.auth.getUser();
      if (user) {
        const lastUserId = localStorage.getItem('ride_last_user_id');
        if (lastUserId && lastUserId !== user.id) {
          Storage.clearTrips();
          Storage.setTripOrder([]);
        }
        localStorage.setItem('ride_last_user_id', user.id);
        this.currentUser = user;
        this.useCloud = true;
        this._setAuthState('AUTHENTICATED');
        return true;
      }
      this._setAuthState('UNAUTHENTICATED', 'Signed out');
      return false;
    } catch (error) {
      console.error('Auth check failed', error);
      const reason = error.status === 401
        ? 'Session expired. Please sign in again.'
        : 'Auth check failed. Working offline until re-auth.';
      this._setAuthState(error.status === 401 ? 'UNAUTHENTICATED' : 'ERROR', reason);
      return false;
    }
  },

  handleAuthExpired() {
    if (this._authState !== 'AUTHENTICATED') return;
    this._setAuthState('UNAUTHENTICATED', 'Session expired. Please sign in again.');
  },

  handleConnectionLost(detail) {
    if (this._authState !== 'AUTHENTICATED') {
      if (!this.isSharedView) UI.showAuthGate('Signed out');
      return;
    }
    const kind = detail?.kind;
    const reason = kind === 'network'
      ? 'Signed out — connection lost.'
      : 'Signed out — server unavailable.';
    this._setAuthState('ERROR', reason);
  },

  handleAuthErrorFromUrl(code, description) {
    let message = 'Login failed. Please try again.';
    if (code === 'invalid_state') {
      message = 'Login expired. Please try again.';
    } else if (code === 'request_malformed' || code === 'invalid_request') {
      message = 'Login request was invalid. Please retry.';
    }
    if (description) message = `${message} (${description})`;
    UI.showToast(message, 'error');
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

  updateUserUI() {
    const userBtn = document.getElementById('userBtn');
    const userAvatar = document.getElementById('userAvatar');
    const userInitial = document.getElementById('userInitial');
    if (this.currentUser) {
      userBtn.classList.add('logged-in');
      if (this.currentUser.avatar_url) {
        userAvatar.src = this.currentUser.avatar_url;
        userAvatar.classList.remove('hidden');
        if (userInitial) userInitial.classList.add('hidden');
      } else if (userInitial) {
        // No photo — show coloured initial
        userAvatar.classList.add('hidden');
        userAvatar.removeAttribute('src');
        const name = this.currentUser.name || this.currentUser.email || '?';
        userInitial.textContent = name.charAt(0).toUpperCase();
        userInitial.style.backgroundColor = this._initialColor(name);
        userInitial.classList.remove('hidden');
      }
    } else {
      userBtn.classList.remove('logged-in');
      userAvatar.classList.add('hidden');
      if (userInitial) userInitial.classList.add('hidden');
    }
  },

  /** Deterministic colour from a string */
  _initialColor(str) {
    const palette = [
      '#6366f1','#8b5cf6','#a855f7','#ec4899','#ef4444','#f97316',
      '#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6','#0ea5e9'
    ];
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return palette[Math.abs(hash) % palette.length];
  },

  showUserDropdown() {
    const existing = document.querySelector('.user-dropdown');
    if (existing) { existing.remove(); return; }
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
    setTimeout(() => {
      document.addEventListener('click', function closeDropdown(e) {
        if (!dropdown.contains(e.target) && e.target.id !== 'userBtn') {
          dropdown.remove();
          document.removeEventListener('click', closeDropdown);
        }
      });
    }, 10);
  },

  async logout() {
    try { await API.auth.logout(); } catch (e) {}
    Storage.clearTrips();
    const dropdown = document.querySelector('.user-dropdown');
    if (dropdown) dropdown.remove();
    this._setAuthState('UNAUTHENTICATED', 'Signed out');
    UI.showToast('Signed out', 'success');
  },

  bindSessionRefresh() {
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) return;
      const hadUser = !!this.currentUser;
      const authed = await this.checkAuth();
      if (authed || hadUser) {
        await this.refreshData('visibility');
      }
    });
    window.addEventListener('online', async () => {
      const authed = await this.checkAuth();
      if (authed) await this.refreshData('online');
    });
  }
});
