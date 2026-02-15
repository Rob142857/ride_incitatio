#!/usr/bin/env bash
#
# Refresh OSRM data with zero downtime
# Run weekly via cron:  0 3 * * 0  /srv/ride/infra/refresh-osrm.sh >> /var/log/osrm-refresh.log 2>&1
#
set -euo pipefail

REGION_URL="https://download.geofabrik.de/australia-oceania-latest.osm.pbf"
DATA_DIR="$(cd "$(dirname "$0")" && pwd)/osrm-data"
TMP_DIR="$(cd "$(dirname "$0")" && pwd)/osrm-data-new"
COMPOSE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[$(date -Iseconds)] Starting OSRM data refresh..."

# Download fresh PBF
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
curl -L "$REGION_URL" -o "$TMP_DIR/data.osm.pbf"

# Extract + partition + customize (MLD algorithm)
docker run --rm -t -v "$TMP_DIR":/data osrm/osrm-backend osrm-extract -p /opt/car.lua /data/data.osm.pbf
docker run --rm -t -v "$TMP_DIR":/data osrm/osrm-backend osrm-partition /data/data.osrm
docker run --rm -t -v "$TMP_DIR":/data osrm/osrm-backend osrm-customize /data/data.osrm

# Swap data directory and restart OSRM container
cd "$COMPOSE_DIR"
docker compose stop osrm
rm -rf "${DATA_DIR}.old"
mv "$DATA_DIR" "${DATA_DIR}.old" 2>/dev/null || true
mv "$TMP_DIR" "$DATA_DIR"
docker compose up -d osrm

# Wait for health check
sleep 5
if curl -sf "http://localhost:5000/route/v1/driving/151.2093,-33.8688;151.2153,-33.8568?overview=false" > /dev/null; then
  echo "[$(date -Iseconds)] Refresh complete — OSRM healthy."
  rm -rf "${DATA_DIR}.old"
else
  echo "[$(date -Iseconds)] WARNING: OSRM not responding. Rolling back..."
  docker compose stop osrm
  rm -rf "$DATA_DIR"
  mv "${DATA_DIR}.old" "$DATA_DIR"
  docker compose up -d osrm
  echo "[$(date -Iseconds)] Rolled back to previous data."
  exit 1
fi
