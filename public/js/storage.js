/**
 * Storage module - handles local storage for trips and data
 */
const Storage = {
  KEYS: {
    TRIPS: 'ride_trips',
    CURRENT_TRIP: 'ride_current_trip',
    SETTINGS: 'ride_settings'
  },

  /**
   * Save data to localStorage
   */
  save(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('Storage save error:', e);
      return false;
    }
  },

  /**
   * Load data from localStorage
   */
  load(key, defaultValue = null) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defaultValue;
    } catch (e) {
      console.error('Storage load error:', e);
      return defaultValue;
    }
  },

  /**
   * Remove data from localStorage
   */
  remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.error('Storage remove error:', e);
      return false;
    }
  },

  /**
   * Get all trips
   */
  getTrips() {
    return this.load(this.KEYS.TRIPS, []);
  },

  /**
   * Save all trips
   */
  saveTrips(trips) {
    return this.save(this.KEYS.TRIPS, trips);
  },

  /**
   * Get current trip ID
   */
  getCurrentTripId() {
    return this.load(this.KEYS.CURRENT_TRIP, null);
  },

  /**
   * Set current trip ID
   */
  setCurrentTripId(id) {
    return this.save(this.KEYS.CURRENT_TRIP, id);
  },

  /**
   * Get trip by ID
   */
  getTrip(id) {
    const trips = this.getTrips();
    return trips.find(t => t.id === id) || null;
  },

  /**
   * Save a single trip (update or add)
   */
  saveTrip(trip) {
    const trips = this.getTrips();
    const index = trips.findIndex(t => t.id === trip.id);
    
    if (index >= 0) {
      trips[index] = trip;
    } else {
      trips.push(trip);
    }
    
    return this.saveTrips(trips);
  },

  /**
   * Delete a trip
   */
  deleteTrip(id) {
    const trips = this.getTrips();
    const filtered = trips.filter(t => t.id !== id);
    return this.saveTrips(filtered);
  },

  /**
   * Get settings
   */
  getSettings() {
    return this.load(this.KEYS.SETTINGS, {
      mapStyle: 'default',
      units: 'metric',
      autoSave: true
    });
  },

  /**
   * Save settings
   */
  saveSettings(settings) {
    return this.save(this.KEYS.SETTINGS, settings);
  },

  /**
   * Generate unique ID
   */
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  },

  /**
   * Export all data
   */
  exportAll() {
    return {
      trips: this.getTrips(),
      settings: this.getSettings(),
      exportedAt: new Date().toISOString()
    };
  },

  /**
   * Import data
   */
  importData(data) {
    if (data.trips) {
      this.saveTrips(data.trips);
    }
    if (data.settings) {
      this.saveSettings(data.settings);
    }
    return true;
  },

  clearTrips() {
    this.saveTrips([]);
    this.remove(this.KEYS.CURRENT_TRIP);
  }
};

// Make available globally
window.Storage = Storage;
