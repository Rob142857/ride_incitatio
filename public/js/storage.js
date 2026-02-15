/**
 * Storage module - handles local storage for trips and data
 */
const Storage = {
  KEYS: {
    TRIPS: 'ride_trips',
    CURRENT_TRIP: 'ride_current_trip',
    SETTINGS: 'ride_settings',
    TRIP_ORDER: 'ride_trip_order'
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
   * Generate unique ID
   */
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  },

  /**
   * Get trip order
   */
  getTripOrder() {
    return this.load(this.KEYS.TRIP_ORDER, []);
  },

  /**
   * Set trip order
   */
  setTripOrder(order) {
    return this.save(this.KEYS.TRIP_ORDER, order || []);
  },

  clearTrips() {
    this.saveTrips([]);
    this.remove(this.KEYS.CURRENT_TRIP);
    this.remove(this.KEYS.TRIP_ORDER);
  }
};

// Make available globally
window.Storage = Storage;
