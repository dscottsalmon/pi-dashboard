
#!/usr/bin/env python3

import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

CHECK_INTERVAL = 30
STATE_FILE = Path("/var/lib/pi-dashboard/tailscale-status.json")


def get_status():
    result = subprocess.run(
        ["tailscale", "status", "--json"],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    return json.loads(result.stdout)


def summarize_device(device):
    ips = device.get("TailscaleIPs") or []
    ipv4 = next((ip for ip in ips if "." in ip), None)

    return {
        "name": device.get("DNSName", "").split(".")[0]
                or device.get("HostName", "Unknown"),
        "os": device.get("OS", "unknown"),
        "ip": ipv4,
        "online": bool(device.get("Online", False)),
        "active": bool(device.get("Active", False)),
    }


def collect():
    status = get_status()

    devices = []

    if status.get("Self"):
        devices.append(summarize_device(status["Self"]))

    for peer in status.get("Peer", {}).values():
        devices.append(summarize_device(peer))

    devices.sort(key=lambda d: (not d["online"], d["name"].lower()))

    return {
        "backend": status.get("BackendState", "Unknown"),
        "total": len(devices),
        "online": sum(d["online"] for d in devices),
        "offline": sum(not d["online"] for d in devices),
        "active_peers": sum(d["active"] for d in devices),
        "devices": devices,
        "last_check": datetime.now(timezone.utc).isoformat(),
    }


def save_state(data):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2))
    os.replace(temporary, STATE_FILE)


def main():
    print("Tailscale monitor started", flush=True)

    while True:
        try:
            data = collect()
            save_state(data)

            print(
                f"Tailscale: {data['online']}/{data['total']} online",
                flush=True,
            )

        except (subprocess.SubprocessError, OSError, ValueError) as error:
            print(f"Tailscale collection failed: {error}", flush=True)
            # Keep the last successful snapshot; the API will
            # later use last_check to identify stale data.

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
