
#!/usr/bin/env python3

import json
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

CHECK_URL = "https://www.google.com/generate_204"
CHECK_INTERVAL = 30
FAILURE_THRESHOLD = 3

STATE_FILE = Path("/var/lib/pi-dashboard/internet-status.json")
BOOT_ID_FILE = Path("/proc/sys/kernel/random/boot_id")

def check_internet():
    try:
        request = urllib.request.Request(
            CHECK_URL,
            headers={"User-Agent": "PiDashboard/1.0"}
        )

        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status == 204

    except Exception:
        return False


def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {
            "online": False,
            "online_since": None,
            "last_check": None,
            "consecutive_failures": 0,
        }


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2))
    os.replace(temporary, STATE_FILE)


def main():
    state = load_state()
    boot_id = BOOT_ID_FILE.read_text().strip()

    if state.get("boot_id") != boot_id:
        state["online"] = False
        state["online_since"] = None
        state["consecutive_failures"] = 0

    state["boot_id"] = boot_id

    print("Internet uptime monitor started", flush=True)

    while True:
        now = datetime.now(timezone.utc).isoformat()
        connected = check_internet()

        if connected:
            if not state["online"]:
                state["online_since"] = now
                print(f"Internet online at {now}", flush=True)

            state["online"] = True
            state["consecutive_failures"] = 0

        else:
            state["consecutive_failures"] += 1

            if state["consecutive_failures"] >= FAILURE_THRESHOLD:
                if state["online"]:
                    print(f"Internet outage detected at {now}", flush=True)

                state["online"] = False
                state["online_since"] = None

        state["last_check"] = now
        save_state(state)

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
