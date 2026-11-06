#!/usr/bin/env python3

import json
import os
from datetime import datetime, timezone
from pathlib import Path

STATS_FILE = Path(
    os.environ.get(
        "TAILSCALE_STATS_FILE",
        "/var/lib/pi-dashboard/tailscale-stats.json",
    )
)


def load_stats():
    """Read lifetime statistics without incrementing."""

    if not STATS_FILE.exists():
        return {"lifetime_updates": 0, "last_snapshot": None}

    return json.loads(STATS_FILE.read_text())


def record_update(snapshot_id):
    """Count a monitoring snapshot once across all dashboards."""

    stats = load_stats()

    if stats.get("last_snapshot") == snapshot_id:
        return stats

    stats["lifetime_updates"] += 1
    stats["last_snapshot"] = snapshot_id
    stats["last_updated"] = datetime.now(timezone.utc).isoformat()

    STATS_FILE.parent.mkdir(parents=True, exist_ok=True)

    temporary = STATS_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(stats, indent=2))
    os.replace(temporary, STATS_FILE)

    return stats
