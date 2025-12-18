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

## 8) Maintenance tips
- To update maps: download a fresh `*.osm.pbf`, rerun extract + contract, then restart the container.
- To stop/remove: `sudo docker stop osrm && sudo docker rm osrm`.
- Monitor logs: `sudo docker logs -f osrm`.

## 9) Rough sizing
- Small region (state/province): 4 GB RAM is usually fine.
- Whole-country extracts can need 8–16 GB+; adjust VM size accordingly.
