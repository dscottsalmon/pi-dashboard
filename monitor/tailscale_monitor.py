
#!/usr/bin/env python3

import json
import os
import subprocess
import time
import re


from datetime import datetime, timedelta, timezone
from pathlib import Path

CHECK_INTERVAL = 30
STATE_FILE = Path("/var/lib/pi-dashboard/tailscale-status.json")

HISTORY_WINDOW = 600  # 10 minutes, in seconds
HISTORY_FILE = Path("/var/lib/pi-dashboard/tailscale-history.json")

def load_history():
    """Load saved Tailscale history from disk."""

    try:
        with HISTORY_FILE.open("r") as file:
            return json.load(file)

    except FileNotFoundError:
        return {}

    except (OSError, ValueError) as error:
        print(f"Failed to load Tailscale history: {error}", flush=True)
        return {}


def save_history(history):
    """Atomically save Tailscale history to disk."""

    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)

    temporary = HISTORY_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(history, indent=2))

    os.replace(temporary, HISTORY_FILE)

def update_device_history(history, device, now):
    """Update rolling latency and observed online duration."""

    device_id = device["ip"] or device["name"]
    record = history.setdefault(device_id, {
        "samples": [],
        "online_since": None,
    })

    online = device["online"]
    latency = device["latency_ms"]

    # Track the beginning of the observed online session.
    if online:
        if record.get("online_since") is None:
                record["online_since"] = now.isoformat()
                record["samples"] = []
    else:
            record["online_since"] = None
            record["samples"] = []

    # Record the latest measurement, including failed probes.
    record["samples"].append({
        "timestamp": now.isoformat(),
        "latency_ms": latency if online else None,
    })

    # Keep only samples from the last 10 minutes.
    cutoff = now.timestamp() - HISTORY_WINDOW

    record["samples"] = [
        sample
        for sample in record["samples"]
        if datetime.fromisoformat(sample["timestamp"]).timestamp() >= cutoff
    ]

    # Calculate statistics from successful measurements only.
    latencies = [
        sample["latency_ms"]
        for sample in record["samples"]
        if isinstance(sample["latency_ms"], (int, float))
    ]

    device["latency_history"] = record["samples"]
    device["latency_avg_10m"] = (
        round(sum(latencies) / len(latencies), 1)
        if latencies else None
    )
    device["latency_min_10m"] = min(latencies) if latencies else None
    device["latency_max_10m"] = max(latencies) if latencies else None

    online_since = record["online_since"]

    device["online_since"] = online_since
    device["online_seconds"] = (
        max(0, int(
            (now - datetime.fromisoformat(online_since)).total_seconds()
        ))
        if online_since else None
    )

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
        return "Local"

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


def collect(history):
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

    now = datetime.now(timezone.utc)

    for device in devices:
        update_device_history(history, device, now)

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

    history = load_history()

    while True:
        try:
            data = collect(history)

            data["next_check"] = (
                datetime.now(timezone.utc) + timedelta(seconds=CHECK_INTERVAL)
            ).isoformat()

            save_state(data)
            save_history(history)

            print(
                f"Tailscale: {data['online']}/{data['total']} online",
                flush=True,
            )

        except (subprocess.SubprocessError, OSError, ValueError) as error:
            print(f"Tailscale collection failed: {error}", flush=True)

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
