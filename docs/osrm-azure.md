# OSRM on Azure Linux VM (Docker)

These steps set up a self-hosted OSRM server for driving on a small regional extract. Adjust URLs/paths as needed.

## 1) Provision VM
- Azure: create a Linux VM (Ubuntu 22.04 LTS), at least 2 vCPUs / 4 GB RAM (more for larger extracts), with port 5000 open on the NSG.
- SSH in as your admin user.

## 2) Install Docker
```bash
sudo apt-get update
sudo apt-get install -y docker.io
sudo systemctl enable --now docker
```

## 3) Pick a region extract
Choose a PBF from Geofabrik (example: Australia/Oceania – NSW):
```bash
wget https://download.geofabrik.de/australia-oceania/new-south-wales-latest.osm.pbf -O data.osm.pbf
```

## 4) Prepare OSRM data (extract + contract)
Using the official OSRM Docker image:
```bash
# Extract (driving profile)
sudo docker run -t -v $(pwd):/data osrm/osrm-backend osrm-extract -p /opt/car.lua /data/data.osm.pbf

# Contract
auth=$(whoami) # keep ownership clean
sudo docker run -t -v $(pwd):/data osrm/osrm-backend osrm-contract /data/data.osrm
sudo chown ${auth}:${auth} /home/${auth}/*.osrm* 2>/dev/null || true
```
Results: files like `data.osrm`, `data.osrm.hsgr`, etc. stay in the current directory.

## 5) Run the OSRM HTTP server
```bash
sudo docker run -d \
  --name osrm \
  -p 5000:5000 \
  -v $(pwd):/data \
  osrm/osrm-backend osrm-routed --algorithm mld /data/data.osrm
```

Check health:
```bash
curl "http://localhost:5000/route/v1/driving/151.2093,-33.8688;151.2153,-33.8568?overview=false"
```
You should get JSON with routes.

## 6) Set a DNS and TLS (recommended)
- Point a DNS record (e.g., routing.example.com) to the VM public IP.
- Terminate TLS via a reverse proxy (e.g., Caddy or Nginx with Let’s Encrypt) forwarding to `localhost:5000`.

### Example: quick Caddy reverse proxy with HTTPS
```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo tee /etc/apt/trusted.gpg.d/caddy-stable.asc
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# /etc/caddy/Caddyfile
routing.example.com {
    reverse_proxy localhost:5000
}

sudo systemctl reload caddy
```

## 7) Point the app to your OSRM
In `public/js/map.js`, set `serviceUrl` in the `L.Routing.control` options, e.g.:
```js
this.routingControl = L.Routing.control({
  serviceUrl: 'https://routing.example.com/route/v1',
  // ...existing options
});
```

## 8) Keep data local (no per-request downloads)
OSRM serves routes from the preprocessed `.osrm` files you keep on disk. Clients never download map data through your server—only route JSON. To avoid fetching data per request, keep the preprocessed dataset in a durable directory and reuse it across container restarts.

### Suggested layout
```bash
sudo mkdir -p /srv/osrm/data
sudo chown $USER:$USER /srv/osrm/data
cd /srv/osrm/data
```

### One-time (or periodic) data prep
```bash
REGION_URL="https://download.geofabrik.de/australia-oceania/new-south-wales-latest.osm.pbf"
curl -L "$REGION_URL" -o data.osm.pbf

# Extract + contract once per dataset refresh
docker run -t -v /srv/osrm/data:/data osrm/osrm-backend osrm-extract -p /opt/car.lua /data/data.osm.pbf
docker run -t -v /srv/osrm/data:/data osrm/osrm-backend osrm-contract /data/data.osrm
```

### Run OSRM against the cached dataset
```bash
docker run -d \
  --name osrm \
  -p 5000:5000 \
  -v /srv/osrm/data:/data \
  osrm/osrm-backend osrm-routed --algorithm mld /data/data.osrm
```

The container reads the preprocessed files from `/srv/osrm/data`; no further map downloads occur during routing.

### Updating data without downtime (rolling)
1) Prepare new data beside the existing set (e.g., `/srv/osrm/data-2025-01`), run extract/contract there.
2) Start a new container pointing at the new path on a different port (e.g., 5001) and health-check it.
3) Switch your reverse proxy to the new port.
4) Stop the old container and archive or delete the old data directory when satisfied.

### Quick refresh script (weekly)
```bash
#!/usr/bin/env bash
set -euo pipefail
REGION_URL="https://download.geofabrik.de/australia-oceania/new-south-wales-latest.osm.pbf"
DATA_DIR=/srv/osrm/data
TMP_DIR=/srv/osrm/data-tmp

rm -rf "$TMP_DIR" && mkdir -p "$TMP_DIR"
curl -L "$REGION_URL" -o "$TMP_DIR/data.osm.pbf"
docker run -t -v "$TMP_DIR":/data osrm/osrm-backend osrm-extract -p /opt/car.lua /data/data.osm.pbf
docker run -t -v "$TMP_DIR":/data osrm/osrm-backend osrm-contract /data/data.osrm

docker stop osrm || true
docker rm osrm || true
rm -rf "$DATA_DIR"
mv "$TMP_DIR" "$DATA_DIR"
docker run -d --name osrm -p 5000:5000 -v "$DATA_DIR":/data osrm/osrm-backend osrm-routed --algorithm mld /data/data.osrm
```

## 9) Maintenance tips
- To stop/remove: `sudo docker stop osrm && sudo docker rm osrm`.
- Monitor logs: `sudo docker logs -f osrm`.

## 10) Rough sizing
- Small region (state/province): 4 GB RAM is usually fine.
- Whole-country extracts can need 8–16 GB+; adjust VM size accordingly.

## 9) Rough sizing
- Small region (state/province): 4 GB RAM is usually fine.
- Whole-country extracts can need 8–16 GB+; adjust VM size accordingly.
