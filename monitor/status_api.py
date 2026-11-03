
#!/usr/bin/env python3

import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

DATA_DIR = Path("/data")

ENDPOINTS = {
    "/status": "internet-status.json",
    "/tailscale": "tailscale-status.json",
}


class StatusHandler(BaseHTTPRequestHandler):

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
        if self.path == "/tailscale":
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
