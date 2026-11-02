
#!/usr/bin/env python3

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

STATUS_FILE = Path("/data/internet-status.json")


class StatusHandler(BaseHTTPRequestHandler):

    def do_GET(self):
        if self.path != "/status":
            self.send_error(404)
            return

        try:
            data = json.loads(STATUS_FILE.read_text())

        except (OSError, json.JSONDecodeError):
            self.send_error(503, "Status unavailable")
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
    print("Internet status API listening on port 8080", flush=True)
    server.serve_forever()
