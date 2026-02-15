/**
 * Shared utility functions — used by multiple controllers and modules.
 * Loaded before all controllers so functions are globally available.
 */
const RideUtils = {
  /**
   * Haversine distance (meters) between two points.
   * Accepts {lat, lng}, [lat, lng], or any object with lat/lng properties.
   */
  haversine(a, b) {
    const toRad = (v) => v * Math.PI / 180;
    const R = 6371000;
    const latA = a?.lat ?? a?.[0] ?? 0;
    const lngA = a?.lng ?? a?.[1] ?? 0;
    const latB = b?.lat ?? b?.[0] ?? 0;
    const lngB = b?.lng ?? b?.[1] ?? 0;
    const dLat = toRad(latB - latA);
    const dLng = toRad(lngB - lngA);
    const lat1 = toRad(latA);
    const lat2 = toRad(latB);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  },

  /** Format distance in meters to human-readable string */
  formatDistance(meters) {
    if (!meters && meters !== 0) return '—';
    if (meters >= 1000) return (meters / 1000).toFixed(1) + ' km';
    return Math.round(meters) + ' m';
  },

  /** Format duration in seconds to human-readable string */
  formatDuration(seconds) {
    if (!seconds && seconds !== 0) return '—';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes} min`;
  }
};

window.RideUtils = RideUtils;
