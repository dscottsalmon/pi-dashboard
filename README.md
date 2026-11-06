# Raspberry Pi Server Dashboard

A self-hosted infrastructure dashboard built with [Homepage](https://gethomepage.dev/), Glances, Caddy, Docker Compose, Python, and Tailscale. It combines Raspberry Pi resource monitoring, independent internet uptime tracking, and automatically discovered Tailscale devices in one browser interface.

Developed on a Raspberry Pi 4 with 8 GB RAM running Debian Linux, the dashboard is intended for access over a trusted LAN or private Tailscale network. It is a personal homelab project in active development, exploring Linux administration, containers, networking, monitoring, and frontend customization.

## Capabilities

- CPU utilization, RAM usage, CPU temperature, and system uptime.
- SD card and external-drive storage usage, plus Ethernet traffic and RAM/swap service widgets.
- Internet connectivity and continuous online duration, tracked separately from host uptime.
- Tailscale device discovery, online status, connection details, latency statistics, and rolling history graphs.
- Pi-hole HTTP availability checks and shortcuts to infrastructure and personal services.
- Dark styling, colour-coded resource icons and progress bars, and responsive desktop, tablet, and phone resource layouts.

Dashboard snapshots are stored in `screenshots/`. Review and redact device names, addresses, and other private details before sharing screenshots publicly.

## Architecture and Technology Stack

The deployment has **four Docker Compose services** and **two host-level systemd monitoring services**. The deployment file is `compose.yaml`.

| Component | Role |
|---|---|
| Homepage | Dashboard UI, Glances integration, service cards, and custom API widgets |
| Glances | Host resource monitoring and version 4 metrics API; runs with the host PID namespace |
| Caddy | Reverse proxy providing the dashboard and selected API routes on port 3000 |
| Python status API | Serves monitor snapshots and records dashboard update statistics |
| Docker Compose | Runs Homepage, Glances, the status API, and Caddy with bind-mounted configuration |
| Python host monitors | Collect internet connectivity and Tailscale status into JSON files |
| systemd | Starts and restarts the two host monitors |
| Tailscale | Host VPN client, device inventory, peer connection information, and latency probes |
| Custom JavaScript/CSS | Resource formatting, device status presentation, hover cards, SVG graphs, and update counters |

```text
Browser on trusted LAN / Tailscale
                 |
           Caddy :3000
                 |
       +---------+----------+
       |         |          |
   Homepage   Glances    Python status API :8080
       |      :61208         |             |
       +--> Glances          |             +--> Persistent update statistics
       +--> Status API       v
                      Read-only snapshots
                             ^
                             |
                Host Python monitors (systemd)
                   |                    |
             HTTP connectivity    Tailscale CLI
                   |                    |
                   +--> Persistent JSON state/history
```

Homepage fetches Glances and Tailscale data over the internal Compose network. Browser JavaScript uses same-origin routes through Caddy. Only Caddy publishes a host port in the supplied Compose configuration.

| Browser route | Destination / behavior |
|---|---|
| `/` | Homepage dashboard |
| `/glances-memory` | Glances `/api/4/mem` |
| `/internet-status` | Status API `/status` |
| `/tailscale` | Latest Tailscale snapshot |
| `/tailscale/dashboard` | GET: snapshot with persistent statistics; POST: acknowledge a current snapshot for update counting |

Tailscale runs on the host, outside Compose. Pi-hole and Samba are referenced services, not deployed by this repository.

## Custom Tailscale Monitoring Widget

`monitor/tailscale_monitor.py` reads `tailscale status --json`, including the host and peers visible to that client. Homepage supplies summary counts and a dynamic device list; `config/custom.js` enhances the list with locally hosted OS icons, coloured status indicators, hover details, graphs, and statistics.

### Device discovery and status

- **Automatic discovery:** Uses the host client's Tailscale inventory without maintaining a separate device list in Homepage. Friendly-name mappings and host recognition are currently installation-specific.
- **Online/offline:** Uses Tailscale's reported `Online` state. Offline rows show relative last-seen information when available, or an unknown label.
- **Operating system:** Normalizes reported Windows, Linux, iOS, iPadOS, macOS, and Android names. The UI selects local SVG icons, with a generic fallback and a special Raspberry Pi icon for the configured server.
- **Summary:** Displays online, total, and active-device counts. The total includes the host; the active count sums Tailscale's `Active` flags in the collected inventory.

### Connection method, location, and addresses

| Detail | Meaning in this implementation |
|---|---|
| Host | The configured monitoring host; no self-latency probe is performed |
| Direct | An online peer has a current endpoint (`CurAddr`) |
| Relayed | An online peer has relay information and no current endpoint; the hover card includes the DERP relay identifier when available |
| Offline / Unknown | Peer is offline, or a connection method cannot be determined |
| Local | The host, or an online peer whose current endpoint matches the configured LAN prefix |
| Remote | An online peer whose endpoint does not match that LAN prefix |
| LAN IP | Extracted from a local peer's current endpoint; the host LAN address is configured in the monitor |
| Tailscale IP | The device's first reported Tailscale IPv4 address |

Connection method and network location are separate classifications. Location detection is a simple endpoint-prefix heuristic, not general subnet discovery or geolocation. LAN addresses are shown only for devices classified as local; they are not found by scanning the LAN. Review the host identity, friendly names, LAN prefix, and host LAN address when adapting the monitor.

### Latency and rolling history

For online peers other than the host, the monitor runs `tailscale ping --c 1` against their Tailscale IPv4 address, with a five-second subprocess timeout. It refreshes peer status after probing to obtain updated endpoint information.

Device hover cards show:

- Current measured latency in milliseconds.
- Average latency over the retained 10-minute window.
- Minimum and maximum latency over that same window.
- A rolling 10-minute SVG latency graph with a scaled vertical axis and time labels.
- Observed online duration, operating system, connection method, location, and available IP addresses.

Statistics use successful numeric measurements only. Failed probes are stored as missing samples and break graph lines; unavailable measurements display a dash. A failed latency probe does not itself mark a peer offline: online status comes from Tailscale. Host hover cards omit latency measurements and graphs.

The monitor retains at most 600 seconds of samples for each currently processed device. A detected offline state clears that device's previous latency samples and online-start timestamp; a new observed online session starts a fresh history. The window may therefore contain less than 10 minutes of data.

### Observed online duration and persistence

Online duration starts when the monitor first observes a device online and resets when it observes the device offline. It is **observed connectivity duration**, not device boot uptime or a historical availability percentage. Saved history is loaded on monitor startup, so duration can carry across monitor restarts; outages during monitoring gaps cannot be reconstructed.

Both monitor snapshots and history use temporary files followed by atomic replacement. History persists on the host independently of the browser and containers.

### Refresh timing and update statistics

The monitor sleeps for 30 seconds after each collection. Collection includes sequential peer probes, so the actual snapshot interval can exceed 30 seconds. Homepage's custom API widgets refresh every 30 seconds; browser enhancements request `/tailscale/dashboard` every two seconds to pick up new snapshots and tooltip details.

The device-card footer displays:

- **Lifetime:** Persistent count of new snapshots successfully acknowledged by dashboards through POST requests. The API checks that the snapshot is current and avoids recounting the most recently recorded snapshot across clients.
- **Session:** New snapshots observed since the current page established its initial baseline; resets on page reload.
- **Next update:** Countdown based on the monitor's `next_check`, adjusted using API server time. It can show checking or delayed states.

The first snapshot establishes a session baseline without incrementing counters. Lifetime is a dashboard-acknowledged update count, not every monitor collection while no dashboard is open. Plain GET requests do not increment it.

The API rejects Tailscale snapshots older than 90 seconds, invalid timestamps, and future timestamps with HTTP 503. Browser enhancement fetch failures are logged to the browser console; previously rendered details can remain visible, so check the API and monitor logs when updates stop.

## Other Infrastructure Monitoring

### System resources and service cards

`config/widgets.yaml` enables the Glances resource header for CPU, RAM, storage, CPU temperature, and host uptime. JavaScript formats RAM as used/total GiB and calculates used/total decimal GB from Homepage's free-space readings and configured drive capacities. Those capacities must match the deployment.

`config/services.yaml` adds Glances cards for CPU, memory/swap, temperature, Ethernet traffic, system storage, and external storage. Sensor names, interface names, and filesystem metric paths are specific to the host and should be verified locally.

The Pi-hole card uses Homepage's `siteMonitor` HTTP check. File Server and Docker cards are navigation links, not Samba probes or container-management integrations. `config/docker.yaml` contains commented examples only; no Docker socket is mounted. Personal-service cards provide additional shortcuts.

CSS arranges the seven header resources into four metrics above three on desktop, two columns on tablets, and one column on phones. A DOM mutation observer reapplies custom formatting when Homepage redraws its interface.

### Internet uptime

`monitor/internet_monitor.py` requests `https://www.google.com/generate_204` with a five-second timeout, expecting HTTP 204, then sleeps for 30 seconds between checks.

Three consecutive failed checks mark connectivity offline, avoiding resets for isolated failures. Detection usually takes roughly one to one-and-a-half minutes after an outage, with request durations affecting timing. On the first successful check after an offline state, the monitor records a new `online_since` timestamp.

State is saved atomically to `/var/lib/pi-dashboard/internet-status.json`. A Linux boot ID prevents an online duration from carrying across host reboots; state can survive monitor restarts during the same boot.

The browser fetches internet status every 30 seconds and updates the displayed duration every second. Green indicates online, red indicates offline, and `Unknown` indicates missing or stale information after the 90-second freshness threshold. This measures continuous connectivity to the configured check endpoint, not complete internet reachability or a historical availability percentage.

## Repository Structure

```text
pi-dashboard/
|-- compose.yaml                 # Four container services and bind mounts
|-- config/
|   |-- settings.yaml            # Homepage theme and section layout
|   |-- widgets.yaml             # Glances resource header
|   |-- services.yaml            # Infrastructure, Tailscale, and service cards
|   |-- custom.js                # Resource formatting and Tailscale UI logic
|   |-- custom.css               # Responsive layout, status indicators, tooltips
|   `-- *.yaml                   # Bookmarks and integration placeholders
|-- monitor/
|   |-- internet_monitor.py      # Host connectivity collector
|   |-- tailscale_monitor.py     # Host Tailscale collector and rolling history
|   |-- status_api.py            # JSON API and snapshot acknowledgement endpoint
|   |-- tailscale_stats.py       # Persistent update-counter storage
|   `-- systemd/
|       |-- pi-internet-monitor.service
|       `-- pi-tailscale-monitor.service
|-- proxy/Caddyfile              # Same-origin dashboard/API routing
|-- assets/icons/                # Locally served device OS SVGs
|-- screenshots/                 # Development snapshots
|-- TIMELOG.md                   # Project time log
`-- README.md
```

### Runtime data

Runtime state lives outside the repository:

| Host path under `/var/lib/pi-dashboard/` | Purpose |
|---|---|
| `internet-status.json` | Internet connectivity snapshot |
| `tailscale-status.json` | Latest device inventory, metrics, and next-check time |
| `tailscale-history.json` | Per-device rolling samples and observed online-start timestamps |
| `dashboard-stats/tailscale-stats.json` | Persistent dashboard lifetime update count |

Compose mounts the data directory read-only at `/data` in the status API container. A separate writable mount at `/stats` stores update counters; Compose sets `TAILSCALE_STATS_FILE` to `/stats/tailscale-stats.json`. The host monitor alone updates Tailscale history; the API reads snapshots and writes counters.

## Installation and Configuration

These instructions target a Debian-based Linux host with Python 3, systemd, Docker, and the Docker Compose plugin installed. Tailscale must already be installed, running, and connected to the intended tailnet. The host service user must be able to run `tailscale status --json` and `tailscale ping`.

There is no application build step or Python dependency manifest: the Python scripts use the standard library, and Compose runs published container images.

### 1. Clone the repository

```bash
git clone https://github.com/dscottsalmon/pi-dashboard.git
cd pi-dashboard
```

### 2. Adapt installation-specific settings

Review these files locally before starting services. The supplied configuration targets an existing installation and is not portable without adjustment.

| File | Values to review |
|---|---|
| `compose.yaml` | `HOMEPAGE_ALLOWED_HOSTS`, external storage paths, host mounts, and published port |
| `config/widgets.yaml` | Glances version and disk paths |
| `config/services.yaml` | Service links/check URLs, network interface, sensor, and filesystem metric names |
| `config/custom.js` | `CONFIG.drives` capacities and labels; resource ordering assumptions |
| `monitor/tailscale_monitor.py` | Host recognition and ordering, friendly names, local endpoint prefix, and host LAN IP |
| `monitor/systemd/*.service` | `User`, `Group` where present, `WorkingDirectory`, and absolute `ExecStart` paths |

Host identity is used in several places in the Tailscale collector, and the special host icon also depends on the display name in JavaScript. Keep these consistent. Settings in the scripts are code constants, not undocumented environment-variable options.

Keep private addresses, device mappings, and credentials out of public documentation and shared configuration changes.

### 3. Prepare runtime storage

Create `/var/lib/pi-dashboard` and its `dashboard-stats` subdirectory before starting Compose. Give the configured host monitor user(s) write access to the parent directory for state/history files, and ensure the API container can read snapshots and write its separate statistics directory. These directories are outside the checkout; the supplied systemd units do not provision their permissions.

### 4. Install both host monitoring services

After adapting the units to the local installation:

```bash
sudo cp monitor/systemd/pi-internet-monitor.service /etc/systemd/system/
sudo cp monitor/systemd/pi-tailscale-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pi-internet-monitor.service pi-tailscale-monitor.service
sudo systemctl status pi-internet-monitor.service pi-tailscale-monitor.service
```

The internet service starts after the network-online target. The Tailscale service starts after and wants `tailscaled.service`. Both restart automatically after failure. Confirm they produce current JSON snapshots before troubleshooting browser widgets.

### 5. Validate and start the containers

Run from the repository directory:

```bash
sudo docker compose config --quiet
sudo docker compose up -d
sudo docker compose ps
```

Open `http://<dashboard-host>:3000`. The browser's hostname or address, including the port, must be allowed by `HOMEPAGE_ALLOWED_HOSTS`. Use an address reachable over your trusted LAN or Tailscale connection.

## Maintenance and Troubleshooting

| Task | Command |
|---|---|
| Container status | `sudo docker compose ps` |
| Recent container logs | `sudo docker compose logs --tail=100` |
| Internet monitor logs | `sudo journalctl -u pi-internet-monitor.service -f` |
| Tailscale monitor logs | `sudo journalctl -u pi-tailscale-monitor.service -f` |
| Restart containers | `sudo docker compose restart` |
| Restart host monitors | `sudo systemctl restart pi-internet-monitor.service pi-tailscale-monitor.service` |
| Validate Compose | `sudo docker compose config --quiet` |

Check proxied API responses locally with `curl -f http://localhost:3000/internet-status`, `/tailscale`, `/tailscale/dashboard`, and `/glances-memory` using the same base URL. Snapshot responses contain private device information; redact them before sharing logs or diagnostics.

- **Status unavailable / HTTP 503:** Check monitor logs, state-file permissions, and snapshot freshness. Large peer inventories or slow probes can delay collection beyond the API's 90-second Tailscale freshness limit.
- **Incorrect location, LAN address, or host latency behavior:** Review installation-specific host detection and LAN matching in the Tailscale monitor.
- **Incorrect storage totals or missing metrics:** Check configured drive capacities, mount paths, interface names, and Glances sensor/filesystem identifiers.
- **Missing tooltips, icons, or formatting:** Check the browser console and local icon mount. The customizations depend on Homepage DOM structure and may need adjustment after an upstream update.

To update container images:

```bash
sudo docker compose pull
sudo docker compose up -d
```

Review upstream release notes and configuration compatibility first: Homepage and Glances use moving image tags. Restart the relevant host monitor after changing its Python script; after changing installed systemd units, run `sudo systemctl daemon-reload` and restart the affected service.

Back up `/var/lib/pi-dashboard/` along with local configuration to retain monitoring history and counters. Stop the relevant writers if a consistent backup across multiple files is required. Removing state/history resets the corresponding observations; the rolling history is not a long-term monitoring archive.

## Security Considerations

- Keep port 3000 restricted to trusted LAN or private VPN clients. The supplied Caddy configuration serves HTTP and does not configure authentication or TLS.
- The monitoring API exposes device details and accepts update acknowledgements without authentication; do not publish it to the internet. Router port forwarding is not needed for LAN or Tailscale access.
- `HOMEPAGE_ALLOWED_HOSTS` controls accepted hostnames; it is not user authentication.
- Glances and the Python API have no separately published host ports in Compose. Glances does not mount the Docker socket.
- Preserve read-only mounts where configured. The API statistics directory is intentionally writable.
- `.gitignore` excludes common environment files, keys, backups, logs, and Python-generated files. It does not sanitize tracked configuration or screenshots; review public changes manually and keep runtime data outside the repository.

## Project Status and Roadmap

Implemented: Homepage deployment, Glances resource monitoring, independent internet uptime, Caddy routing, responsive styling, automatic Tailscale device monitoring, persistent rolling latency history, and dashboard update statistics.

Future work:

- Expand service health monitoring.
- Add historical network availability statistics beyond the current rolling latency window.
- Improve portability and installation automation.
