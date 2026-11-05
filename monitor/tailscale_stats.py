#!/usr/bin/env python3

import json
import os
from datetime import datetime, timezone
from pathlib import Path

STATS_FILE = Path("/var/lib/pi-dashboard/tailscale-stats.json")


def record_update():
    """Record a successful Tailscale monitoring cycle."""

    STATS_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Load existing statistics, if available.
    if STATS_FILE.exists():
        stats = json.loads(STATS_FILE.read_text())
    else:
        stats = {
            "lifetime_updates": 0,
        }

    # Increment the lifetime counter.
    stats["lifetime_updates"] += 1
    stats["last_updated"] = datetime.now(timezone.utc).isoformat()

    # Write safely using a temporary file.
    temporary = STATS_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(stats, indent=2))
    os.replace(temporary, STATS_FILE)

    return stats
