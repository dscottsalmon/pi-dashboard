
#!/usr/bin/env python3

import json
import os
import subprocess
import time
import re


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

def measure_latency(ip):
    """Measure Tailscale peer latency in milliseconds."""

    if not ip:
        return None

    try:
        result = subprocess.run(
            ["tailscale", "ping", "--c", "1", ip],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

        if result.returncode != 0:
            return None

        match = re.search(
            r"\bin\s+([\d.]+)ms\b",
            result.stdout,
        )

        if match:
            return float(match.group(1))

    except (subprocess.SubprocessError, OSError):
        pass

    return None

def get_location(device, is_self=False):
    """Classify a Tailscale peer using its current endpoint."""

    if is_self:
        return "Host"

    if not device.get("Online", False):
        return "Offline"

    endpoint = device.get("CurAddr") or ""

    if endpoint.startswith("192.168.0."):
        return "Local"

    return "Remote"

def format_last_seen(timestamp):
    """Convert a Tailscale timestamp to relative time."""

    if not timestamp or timestamp.startswith("0001-"):
        return "Unknown"

    try:
        last_seen = datetime.fromisoformat(
            timestamp.replace("Z", "+00:00")
        )

        seconds = max(
            0,
            int((datetime.now(timezone.utc) - last_seen).total_seconds())
        )

        if seconds < 60:
            return "Just now"
        if seconds < 3600:
            return f"{seconds // 60}m ago"
        if seconds < 86400:
            return f"{seconds // 3600}h ago"

        return f"{seconds // 86400}d ago"

    except ValueError:
        return "Unknown"
        
def summarize_device(device):
    ips = device.get("TailscaleIPs") or []
    ipv4 = next((ip for ip in ips if "." in ip), None)

    hostname = (
        device.get("DNSName", "").split(".")[0]
        or device.get("HostName", "Unknown")
    )

    friendly_names = {
        "pihole-server": "Pi Server",
        "desktop-le51g90": "Desktop",
        "laptop-q2jfsefb": "Laptop",
        "iphone16pro": "iPhone 16 Pro",
    }

    online = bool(device.get("Online", False))

    is_self = device.get("HostName", "").lower() == "pihole-server"

    latency_ms = (
        measure_latency(ipv4)
        if online and not is_self
        else None
    )

    latency_label = (
        "—" if is_self
        else f"{latency_ms:g} ms" if latency_ms is not None
        else "—"
    )

    # Refresh the peer's endpoint after the latency probe.
    if online and not is_self:
        try:
            fresh_status = get_status()
            device = next(
                (
                    peer
                    for peer in fresh_status.get("Peer", {}).values()
                    if ipv4 in (peer.get("TailscaleIPs") or [])
                ),
                device,
            )
        except (subprocess.SubprocessError, OSError, ValueError):
            pass

    location = get_location(device, is_self)
    last_seen = device.get("LastSeen")

    if not online:
        elapsed = format_last_seen(last_seen)
        connection_label = (
            f"— | Last seen {elapsed}"
            if elapsed != "Unknown"
            else "— | Last seen unknown"
        )
    else:
        connection_label = f"{latency_label} | {location}"

    os_raw = device.get("OS", "Unknown")
    os_names = {
	    "windows": "Windows",
	    "linux": "Linux",
	    "ios": "iOS",
	    "macos": "macOS",
	    "darwin": "macOS",
	    "android": "Android",
	    "ipados": "iPadOS",
	}

    os_name = os_names.get(os_raw.lower(), os_raw)

    return {
        "name": hostname,
        "display_name": (
    		f"{friendly_names.get(hostname.lower(), hostname)}"
    		f" ({os_name})"),
        "os": os_name,
        "ip": ipv4,
        "online": online,
        "status": "Online" if online else "Offline",
        "active": bool(device.get("Active", False)),
        "latency_ms": latency_ms,
        "latency_label": latency_label,
        "location": location,
        "last_seen": last_seen,
        "connection_label": connection_label,
        "connection_method": (
            "Host" if is_self
            else "Offline" if not online
            else "Direct" if device.get("CurAddr")
            else "Relayed" if device.get("Relay")
            else "Unknown"
        ),
        "endpoint": device.get("CurAddr") or None,
        "relay": device.get("Relay") or None,
    }


def collect():
    status = get_status()

    devices = []

    if status.get("Self"):
        devices.append(summarize_device(status["Self"]))

    for peer in status.get("Peer", {}).values():
        devices.append(summarize_device(peer))

    devices.sort(
    key=lambda d: (
        d["name"].lower() != "pihole-server",
        d["display_name"].lower(),
    		)
	)

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
