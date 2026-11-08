
#!/usr/bin/env python3

import json
import logging
import os
import subprocess
import time
import queue
import threading

from datetime import datetime, timedelta, timezone
from pathlib import Path

# Configuration
SPEEDTEST_BIN = Path.home() / "tools/ookla-speedtest/speedtest"
DATA_DIR = Path("/var/lib/pi-dashboard")
STATUS_FILE = DATA_DIR / "speedtest-status.json"
REQUEST_DIR = DATA_DIR / "speedtest-requests"
TRIGGER_FILE = REQUEST_DIR / "run"

CHECK_INTERVAL = 5
TEST_INTERVAL = 6 * 60 * 60
TEST_TIMEOUT = 120
MANUAL_COOLDOWN = 10 * 60
PROGRESS_WRITE_INTERVAL = 0.5

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s: %(message)s",
)


def utc_now():
    return datetime.now(timezone.utc)


def iso_now():
    return utc_now().isoformat()


def save_status(status):
    """Atomically write the latest speed-test status."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    temporary = STATUS_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(status, indent=4))
    os.replace(temporary, STATUS_FILE)


def load_status():
    """Restore the last saved status after a restart."""
    try:
        return json.loads(STATUS_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def parse_timestamp(value):
    if not value:
        return None

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def run_speedtest(status):
    """Run Ookla Speedtest and persist the result."""
    logging.info("Starting internet speed test")

    status["state"] = "running"
    status["stage"] = "connecting"
    status["progress"] = 0.0
    status["current_mbps"] = None
    status["started_at"] = iso_now()
    status["finished_at"] = None
    status["error"] = None
    save_status(status)

    try:
        command = [
            str(SPEEDTEST_BIN),
            "--format=jsonl",
            "--progress=yes",
            "--progress-update-interval=250",
        ]

        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )

        events = queue.Queue()

        def read_output():
            for line in process.stdout:
                events.put(line)
            events.put(None)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()

        data = None
        deadline = time.monotonic() + TEST_TIMEOUT
        last_status_write = time.monotonic()

        try:
            while True:
                remaining = deadline - time.monotonic()

                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, TEST_TIMEOUT)

                try:
                    line = events.get(timeout=remaining)
                except queue.Empty:
                    raise subprocess.TimeoutExpired(command, TEST_TIMEOUT)

                if line is None:
                    break

                event = json.loads(line)
                event_type = event.get("type")

                if event_type in ("testStart", "ping"):
                    stage = "connecting"
                    details = event.get("ping", {})
                elif event_type in ("download", "upload"):
                    stage = event_type
                    details = event.get(event_type, {})
                elif event_type == "result":
                    data = event
                    continue
                else:
                    continue

                previous_stage = status["stage"]
                status["stage"] = stage

                if event_type == "testStart":
                    status["progress"] = 0.0
                else:
                    status["progress"] = max(
                        0.0,
                        min(1.0, float(details.get("progress", 0.0))),
                    )

                if stage in ("download", "upload"):
                    status["current_mbps"] = round(
                        details.get("bandwidth", 0) * 8 / 1_000_000,
                        2,
                    )
                else:
                    status["current_mbps"] = None

                now = time.monotonic()

                if (
                    stage != previous_stage
                    or now - last_status_write >= PROGRESS_WRITE_INTERVAL
                ):
                    save_status(status)
                    last_status_write = now

            remaining = deadline - time.monotonic()

            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, TEST_TIMEOUT)

            return_code = process.wait(timeout=remaining)

            if return_code != 0:
                raise subprocess.CalledProcessError(return_code, command)

        finally:
            if process.poll() is None:
                process.kill()

            process.wait()
            reader.join(timeout=1)

        if data is None:
            raise ValueError("Speedtest returned no result")

        download_mbps = data["download"]["bandwidth"] * 8 / 1_000_000
        upload_mbps = data["upload"]["bandwidth"] * 8 / 1_000_000

        status["result"] = {
            "download_mbps": round(download_mbps, 2),
            "upload_mbps": round(upload_mbps, 2),
            "ping_ms": data["ping"]["latency"],
            "jitter_ms": data["ping"]["jitter"],
            "packet_loss": data.get("packetLoss"),
            "isp": data.get("isp"),
            "server": data.get("server"),
            "result_url": data.get("result", {}).get("url"),
            "timestamp": data["timestamp"],
        }

        status["state"] = "completed"
        status["stage"] = "complete"
        status["progress"] = 1.0
        status["current_mbps"] = None

        logging.info(
            "Speedtest complete: %.2f Mbps down, %.2f Mbps up",
            download_mbps,
            upload_mbps,
        )

    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        OSError,
        ValueError,
        KeyError,
        TypeError,
    ) as exc:
        status["state"] = "failed"
        status["stage"] = "error"
        status["progress"] = 0.0
        status["current_mbps"] = None
        status["error"] = str(exc)[:500]

        logging.error("Speedtest failed: %s", exc)

    finally:
        finished = utc_now()

        status["finished_at"] = finished.isoformat()
        status["next_test_at"] = (
            finished + timedelta(seconds=TEST_INTERVAL)
        ).isoformat()

        save_status(status)

    return status


def main():
    if not SPEEDTEST_BIN.is_file():
        raise FileNotFoundError(
            f"Speedtest executable not found: {SPEEDTEST_BIN}"
        )

    REQUEST_DIR.mkdir(parents=True, exist_ok=True)

    status = load_status()

    # Recover from a restart during an unfinished test.
    if status.get("state") == "running":
        status["state"] = "interrupted"
        status["stage"] = "error"
        status["progress"] = 0.0
        status["current_mbps"] = None
        status["error"] = "Speedtest interrupted by service restart"

    if not parse_timestamp(status.get("next_test_at")):
        status["next_test_at"] = (
            utc_now() + timedelta(seconds=TEST_INTERVAL)
        ).isoformat()

    status.setdefault("state", "idle")
    status.setdefault("stage", "idle")
    status.setdefault("progress", 0.0)
    status.setdefault("current_mbps", None)
    status.setdefault("result", None)
    status.setdefault("error", None)

    save_status(status)

    logging.info("Internet speed-test monitor started")

    while True:
        now = utc_now()

        next_test = parse_timestamp(status.get("next_test_at"))
        last_finished = parse_timestamp(status.get("finished_at"))

        automatic_due = next_test is not None and now >= next_test
        manual_requested = TRIGGER_FILE.exists()

        if manual_requested:
            # Consume the request before doing any work.
            try:
                TRIGGER_FILE.unlink()
            except OSError:
                logging.exception("Unable to remove speedtest trigger")
                time.sleep(CHECK_INTERVAL)
                continue

            cooldown_active = (
                last_finished is not None
                and (now - last_finished).total_seconds() < MANUAL_COOLDOWN
            )

            if cooldown_active:
                logging.info("Manual speedtest ignored: cooldown active")
                manual_requested = False

        if automatic_due or manual_requested:
            status = run_speedtest(status)

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    main()
