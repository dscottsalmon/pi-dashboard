
#!/usr/bin/env python3

import json

from tailscale_stats import load_stats, record_update
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

DATA_DIR = Path("/data")
STATS_DIR = Path("/stats")
STATS_FILE = STATS_DIR / "tailscale-dashboard.json"

ENDPOINTS = {
    "/status": "internet-status.json",
    "/tailscale": "tailscale-status.json",
    "/tailscale/dashboard": "tailscale-status.json",
}


class StatusHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/tailscale/dashboard":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))

            if length <= 0 or length > 1024:
                self.send_error(400, "Invalid request size")
                return

            payload = json.loads(self.rfile.read(length))
            snapshot_id = payload["last_check"]

            # Only count a snapshot that matches the latest monitor output.
            current = json.loads(
                (DATA_DIR / "tailscale-status.json").read_text()
            )

            if snapshot_id != current["last_check"]:
                self.send_error(409, "Snapshot no longer current")
                return

            stats = record_update(snapshot_id)

        except (OSError, ValueError, TypeError, KeyError):
            self.send_error(400, "Invalid snapshot")
            return

        body = json.dumps(stats).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        filename = ENDPOINTS.get(self.path)

        if filename is None:
            self.send_error(404)
            return

        try:
            data = json.loads((DATA_DIR / filename).read_text())

        except (OSError, json.JSONDecodeError):
            self.send_error(503, "Status unavailable")
            return

        # Reject stale Tailscale snapshots.
        if self.path in ("/tailscale", "/tailscale/dashboard"):
            try:
                last_check = datetime.fromisoformat(data["last_check"])
                age = (
                    datetime.now(timezone.utc) - last_check
                ).total_seconds()

                if age < 0 or age > 90:
                    self.send_error(503, "Tailscale status is stale")
                    return

            except (KeyError, ValueError, TypeError):
                self.send_error(503, "Invalid Tailscale status")
                return

        if self.path == "/tailscale/dashboard":
            try:
                data["stats"] = load_stats()
            except (OSError, ValueError, TypeError):
                self.send_error(503, "Dashboard statistics unavailable")
                return

        # Include the server's current time for client clock synchronization.
        if self.path in ("/tailscale", "/tailscale/dashboard"):
            data["server_time"] = datetime.now(timezone.utc).isoformat()

        body = json.dumps(data).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 8080), StatusHandler)
    print("Dashboard status API listening on port 8080", flush=True)
    server.serve_forever()
