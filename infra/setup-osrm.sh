#!/usr/bin/env bash
#
# OSRM Self-Hosted Setup for Ride (maps.incitat.io)
# Run this on your Ubuntu 24.04 server (mjw-ubuntu).
# Prepares Oceania routing data and starts OSRM + Cloudflare Tunnel.
#
set -euo pipefail

REGION_URL="https://download.geofabrik.de/australia-oceania-latest.osm.pbf"
DATA_DIR="$(pwd)/osrm-data"
PBF_FILE="$DATA_DIR/data.osm.pbf"

echo "=== OSRM Setup for Ride ==="
echo "Region: Australia + New Zealand (Oceania)"
echo "Data dir: $DATA_DIR"
echo ""

# --- 1. Create data directory ---
mkdir -p "$DATA_DIR"

# --- 2. Download region extract ---
if [ -f "$PBF_FILE" ]; then
  echo "PBF file already exists at $PBF_FILE — skipping download."
  echo "Delete it and re-run to force a fresh download."
else
  echo "Downloading Oceania extract from Geofabrik (~1.2 GB)..."
  curl -L "$REGION_URL" -o "$PBF_FILE"
  echo "Download complete."
fi

# --- 3. Pre-process: extract + partition + customize ---
echo ""
echo "Extracting road network (car profile)..."
echo "This will take 5-15 minutes depending on CPU."
docker run --rm -t \
  -v "$DATA_DIR":/data \
  osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/data.osm.pbf

echo ""
echo "Partitioning graph (MLD)..."
docker run --rm -t \
  -v "$DATA_DIR":/data \
  osrm/osrm-backend \
  osrm-partition /data/data.osrm

echo ""
echo "Customising graph (MLD)..."
docker run --rm -t \
  -v "$DATA_DIR":/data \
  osrm/osrm-backend \
  osrm-customize /data/data.osrm

echo ""
echo "=== Data preparation complete ==="
echo "Processed files are in: $DATA_DIR"
echo ""
echo "Next steps:"
echo "  1. Set your Cloudflare Tunnel token:  export CLOUDFLARE_TUNNEL_TOKEN='your-token'"
echo "  2. Start services:                    docker compose up -d"
echo "  3. Check health:                      curl http://localhost:5000/route/v1/driving/151.2093,-33.8688;151.2153,-33.8568?overview=false"
echo ""
