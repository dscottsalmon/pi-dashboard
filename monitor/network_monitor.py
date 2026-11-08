
#!/usr/bin/env python3

import json
import os
import time
import math
import shutil
from datetime import datetime, timezone
from pathlib import Path

CHECK_INTERVAL = 1
INTERFACE = "eth0"

STATS_PATH = Path(f"/sys/class/net/{INTERFACE}/statistics")
STATE_FILE = Path("/var/lib/pi-dashboard/network-status.json")

HISTORY_WINDOW = 600
HISTORY_FILE = Path("/var/lib/pi-dashboard/network-history.json")
TOTALS_FILE = Path("/var/lib/pi-dashboard/network-totals.json")
BOOT_ID_FILE = Path("/proc/sys/kernel/random/boot_id")

HISTORY_SAVE_INTERVAL = 30

def read_counter(name):
    """Read a cumulative Linux network interface counter."""
    return int((STATS_PATH / name).read_text().strip())

def read_link_speed():
    """Read the negotiated Ethernet link speed in Mbps."""
    path = Path(f"/sys/class/net/{INTERFACE}/speed")

    try:
        speed = int(path.read_text().strip())
        return speed if speed > 0 else None
    except (OSError, ValueError):
        return None


def read_system_uptime():
    """Read the Raspberry Pi's system uptime in seconds."""
    try:
        return float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None
        
def save_state(data):
    """Atomically save the latest network measurements."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2))
    os.replace(temporary, STATE_FILE)


def save_json(path, data):
    """Atomically write JSON data."""
    path.parent.mkdir(parents=True, exist_ok=True)

    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2))
    os.replace(temporary, path)


def load_json(path, default):
    """Load JSON, preserving invalid files for diagnosis."""
    try:
        data = json.loads(path.read_text())

        if not isinstance(data, type(default)):
            raise ValueError("Unexpected JSON structure")

        return data

    except FileNotFoundError:
        return default

    except (OSError, ValueError, TypeError) as error:
        print(f"Failed to load {path}: {error}", flush=True)

        try:
            backup = path.with_name(
                f"{path.name}.corrupt-{int(time.time_ns())}"
            )
            shutil.copy2(path, backup)
            print(f"Preserved invalid file: {backup}", flush=True)
        except OSError as backup_error:
            print(f"Backup failed: {backup_error}", flush=True)

        return default


def load_history():
    history = load_json(HISTORY_FILE, [])

    valid = []

    for sample in history:
        if not isinstance(sample, dict):
            continue

        try:
            timestamp = float(sample["timestamp"])
            rx = float(sample["rx_bytes_per_sec"])
            tx = float(sample["tx_bytes_per_sec"])

            if not all(
                math.isfinite(value)
                for value in (timestamp, rx, tx)
            ):
                continue

            if rx < 0 or tx < 0:
                continue

            valid.append({
                "timestamp": timestamp,
                "rx_bytes_per_sec": rx,
                "tx_bytes_per_sec": tx,
            })

        except (KeyError, TypeError, ValueError):
            continue

    return valid


def load_totals(boot_id, rx, tx):
    data = load_json(TOTALS_FILE, {})

    required = (
        "boot_id",
        "last_rx",
        "last_tx",
        "lifetime_rx",
        "lifetime_tx",
    )

    if not all(key in data for key in required):
        return {
            "boot_id": boot_id,
            "last_rx": rx,
            "last_tx": tx,
            "lifetime_rx": 0,
            "lifetime_tx": 0,
        }

    try:
        for key in required[1:]:
            if type(data[key]) is not int or data[key] < 0:
                raise ValueError(f"Invalid {key}")

        if not isinstance(data["boot_id"], str):
            raise ValueError("Invalid boot_id")

    except ValueError as error:
        print(f"Invalid network totals: {error}", flush=True)
        return {
            "boot_id": boot_id,
            "last_rx": rx,
            "last_tx": tx,
            "lifetime_rx": 0,
            "lifetime_tx": 0,
        }

    return data


def main():
    print("Network traffic monitor started", flush=True)

    boot_id = BOOT_ID_FILE.read_text().strip()

    previous_rx = read_counter("rx_bytes")
    previous_tx = read_counter("tx_bytes")
    previous_time = time.monotonic()

    totals = load_totals(boot_id, previous_rx, previous_tx)
    history = load_history()

    last_checkpoint = time.monotonic()

    try:
        while True:
            time.sleep(CHECK_INTERVAL)

            try:
                current_rx = read_counter("rx_bytes")
                current_tx = read_counter("tx_bytes")
                current_time = time.monotonic()

                elapsed = current_time - previous_time

                rx_delta = current_rx - previous_rx
                tx_delta = current_tx - previous_tx

                counters_valid = (
                    elapsed > 0
                    and rx_delta >= 0
                    and tx_delta >= 0
                )

                rx_rate = rx_delta / elapsed if counters_valid else None
                tx_rate = tx_delta / elapsed if counters_valid else None

                same_boot = totals["boot_id"] == boot_id

                if (
                    same_boot
                    and current_rx >= totals["last_rx"]
                    and current_tx >= totals["last_tx"]
                ):
                    totals["lifetime_rx"] += current_rx - totals["last_rx"]
                    totals["lifetime_tx"] += current_tx - totals["last_tx"]

                totals["boot_id"] = boot_id
                totals["last_rx"] = current_rx
                totals["last_tx"] = current_tx

                now = datetime.now(timezone.utc)
                timestamp = now.timestamp()

                if counters_valid:
                    history.append({
                        "timestamp": timestamp,
                        "rx_bytes_per_sec": rx_rate,
                        "tx_bytes_per_sec": tx_rate,
                    })

                cutoff = timestamp - HISTORY_WINDOW

                history = [
                    sample for sample in history
                    if sample["timestamp"] >= cutoff
                ]

                data = {
                    "interface": INTERFACE,
                    "rx_bytes": current_rx,
                    "tx_bytes": current_tx,
                    "rx_bytes_per_sec": rx_rate,
                    "tx_bytes_per_sec": tx_rate,
                    "lifetime_rx_bytes": totals["lifetime_rx"],
                    "lifetime_tx_bytes": totals["lifetime_tx"],
                    "link_speed_mbps": read_link_speed(),
                    "uptime_seconds": read_system_uptime(),
                    "history": history,
                    "last_check": now.isoformat(),
                }

                save_state(data)

                if current_time - last_checkpoint >= HISTORY_SAVE_INTERVAL:
                    save_json(HISTORY_FILE, history)
                    save_json(TOTALS_FILE, totals)
                    last_checkpoint = current_time

                if counters_valid:
                    print(
                        f"Network: RX {rx_rate / 1_000_000:.3f} MB/s, "
                        f"TX {tx_rate / 1_000_000:.3f} MB/s",
                        flush=True,
                    )
                else:
                    print("Network counters reset", flush=True)

                previous_rx = current_rx
                previous_tx = current_tx
                previous_time = current_time

            except (OSError, ValueError, ZeroDivisionError) as error:
                print(f"Network collection failed: {error}", flush=True)

    except KeyboardInterrupt:
        print("\nNetwork traffic monitor stopped", flush=True)

    finally:
        save_json(HISTORY_FILE, history)
        save_json(TOTALS_FILE, totals)

if __name__ == "__main__":
    main()
