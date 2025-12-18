/**
 * Google Places proxy for waypoint search
 */
import { jsonResponse, errorResponse } from './utils.js';

export const PlacesHandler = {
  async search(context) {
    const { request, env } = context;
    const apiKey = env.GOOGLE_PLACES_API_KEY;

    if (!apiKey) {
      return errorResponse('Places search not configured', 503);
    }

    const url = new URL(request.url);
    const query = (url.searchParams.get('q') || '').trim();
    const lat = url.searchParams.get('lat');
    const lng = url.searchParams.get('lng');
    const radius = url.searchParams.get('radius') || '50000';
    const region = url.searchParams.get('region') || '';

    if (!query) {
      return errorResponse('Missing query', 400);
    }

    const apiUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    apiUrl.searchParams.set('query', query);
    apiUrl.searchParams.set('key', apiKey);
    apiUrl.searchParams.set('language', 'en');
    if (lat && lng) {
      apiUrl.searchParams.set('location', `${lat},${lng}`);
      apiUrl.searchParams.set('radius', radius);
    }
    if (region) {
      apiUrl.searchParams.set('region', region);
    }

    let data;
    try {
      const resp = await fetch(apiUrl.toString());
      data = await resp.json();
    } catch (error) {
      console.error('Places API network error:', error);
      return errorResponse('Places search failed', 502);
    }

    if (data?.status && !['OK', 'ZERO_RESULTS'].includes(data.status)) {
      console.error('Places API error:', data.status, data?.error_message);
      return errorResponse('Places search unavailable', 502);
    }

    const results = (data?.results || []).slice(0, 12).map((place) => ({
      id: place.place_id,
      name: place.name,
      address: place.formatted_address || place.vicinity || '',
      location: place.geometry?.location
        ? { lat: place.geometry.location.lat, lng: place.geometry.location.lng }
        : null,
      rating: place.rating,
      types: place.types || []
    })).filter((p) => p.location);

    return jsonResponse({ results });
  }
};
