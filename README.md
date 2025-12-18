# Ride Trip Planner

A stripped-down Progressive Web App for planning trips with waypoints, custom routes, and a travel journal.

## Features

- 📱 **Fullscreen Navigation Mode** - Designed for mobile use with PWA support
- 📍 **Waypoint Planning** - Add, reorder, and categorize waypoints (scenic, fuel, food, lodging, etc.)
- 🗺️ **Route Customization** - Drag routes to adjust paths, automatic routing between waypoints
- 📝 **Trip Journal** - Add notes with public/private visibility for sharing
- 🔗 **Easy Sharing** - Generate shareable links, export to JSON/GPX, easy collaboration
- 📴 **Offline Support** - Works offline with cached map tiles

## Getting Started

### Running Locally

1. Install a local server (e.g., using npm):
   ```bash
   npm install
   npm start
   ```

2. Open http://localhost:3000 in your browser

3. On mobile, use "Add to Home Screen" for the full PWA experience

### Development

The app is built with vanilla JavaScript and uses:
- **Leaflet.js** - Map display and interaction
- **Leaflet Routing Machine** - Route calculation and display
- **localStorage** - Trip data persistence

### Project Structure

```
Ride/
├── index.html          # Main app shell
├── view.html           # Public trip viewer
├── manifest.json       # PWA manifest
├── sw.js              # Service worker for offline support
├── css/
│   └── app.css        # All styles
├── js/
│   ├── storage.js     # LocalStorage wrapper
│   ├── trip.js        # Trip data model
│   ├── map.js         # Leaflet map management
│   ├── ui.js          # DOM interactions
│   ├── share.js       # Sharing functionality
│   └── app.js         # Main app orchestration
└── icons/
    └── icon.svg       # App icon
```

## Usage

### Creating a Trip

1. Tap the **+Add** button in the Waypoints panel
2. Tap on the map to set the location
3. Enter waypoint details and save
4. Add more waypoints to create a route

### Adding Journal Notes

1. Go to the **Journal** tab
2. Tap **+ Note** to add an entry
3. Check "Private note" to exclude from sharing

### Sharing a Trip

1. Tap the share icon in the top bar
2. Copy the shareable link
3. Use "Share via..." for native sharing
4. Export as JSON or GPX for other apps

### Integration with Notes Apps

The share link can be embedded in any notes app:

```markdown
[My Road Trip](https://your-domain.com/?trip=abc123)
```

Private notes stay private - only public entries are visible to others.

## Customization

### Map Tiles

To use a different map provider, edit `js/map.js`:

```javascript
L.tileLayer('YOUR_TILE_URL/{z}/{x}/{y}.png', {
  attribution: 'Your attribution'
}).addTo(this.map);
```

### Waypoint Types

Add custom waypoint types in `js/map.js`:

```javascript
waypointIcons: {
  // Add your custom type
  camping: { color: '#22c55e', icon: '⛺' }
}
```

## Browser Support

- Chrome/Edge (Desktop & Mobile)
- Safari (iOS 11.3+)
- Firefox

## License

MIT
