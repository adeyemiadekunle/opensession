"""
What the gateway is doing, for the admin page (GET /admin/overview) and Prometheus
(GET /admin/metrics), plus one JSON log line per request.

Everything is in memory and covers this process since it started (the gateway runs as
one process: terminal/browser tickets are in memory too). Paths are recorded as route
templates ("/p/{workspace}/api/{path:path}"), never with ids or query strings, and the
user id is only kept on errors and lifecycle events, which an admin needs to act on.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections import Counter, deque
from dataclasses import dataclass, field

log = logging.getLogger("opensession.access")

# Long-lived streams (event logs, terminals, the browser) would swamp the latency figures.
STREAMING_ROUTES = ("/log", "/connect")


@dataclass
class Metrics:
    started: float = field(default_factory=time.time)
    # (time, route, status, ms) of recent requests: the windowed figures come from here.
    recent: deque = field(default_factory=lambda: deque(maxlen=5000))
    # Since start, for Prometheus: (method, route, status class) -> count; route -> seconds.
    totals: Counter = field(default_factory=Counter)
    seconds: Counter = field(default_factory=Counter)
    errors: deque = field(default_factory=lambda: deque(maxlen=100))
    events: deque = field(default_factory=lambda: deque(maxlen=300))
    event_totals: Counter = field(default_factory=Counter)

    def request(self, method: str, route: str, status: int, ms: float, user: str | None = None, detail: str | None = None) -> None:
        now = time.time()
        self.totals[(method, route, f"{status // 100}xx")] += 1
        if not route.endswith(STREAMING_ROUTES):
            self.recent.append((now, route, status, ms))
            self.seconds[route] += ms / 1000
        if status >= 500 or status == 429:
            self.errors.append({"time": now, "method": method, "route": route, "status": status, "user": user, "detail": detail})

    def event(self, kind: str, user: str | None = None, workspace: str | None = None, **data) -> None:
        self.event_totals[kind] += 1
        self.events.append({"time": time.time(), "kind": kind, "user": user, "workspace": workspace, **data})

    def summary(self, window: float = 300.0) -> dict:
        """Requests in the last `window` seconds: rate, errors, latency, busiest and slowest routes."""
        since = time.time() - window
        rows = [r for r in self.recent if r[0] >= since]
        ms = sorted(r[3] for r in rows)
        errors = sum(1 for r in rows if r[2] >= 500)
        by_route: dict[str, list[float]] = {}
        for _, route, _, t in rows:
            by_route.setdefault(route, []).append(t)
        routes = [
            {"route": r, "count": len(ts), "p95_ms": round(_pct(sorted(ts), 95), 1)}
            for r, ts in by_route.items()
        ]
        return {
            "window_seconds": int(window),
            "requests": len(rows),
            "per_minute": round(len(rows) / (window / 60), 1),
            "errors": errors,
            "error_rate": round(errors / len(rows), 4) if rows else 0.0,
            "limited": sum(1 for r in rows if r[2] == 429),
            "p50_ms": round(_pct(ms, 50), 1),
            "p95_ms": round(_pct(ms, 95), 1),
            "busiest": sorted(routes, key=lambda r: -r["count"])[:8],
            "slowest": sorted((r for r in routes if r["count"] >= 3), key=lambda r: -r["p95_ms"])[:8],
        }

    def prometheus(self, gauges: dict[str, float]) -> str:
        lines = [
            "# HELP opensession_requests_total Requests handled, by route template and status class.",
            "# TYPE opensession_requests_total counter",
        ]
        for (method, route, cls), n in sorted(self.totals.items()):
            lines.append(f'opensession_requests_total{{method="{method}",route="{_esc(route)}",status="{cls}"}} {n}')
        lines += [
            "# HELP opensession_request_seconds_total Time spent handling requests (streams excluded).",
            "# TYPE opensession_request_seconds_total counter",
        ]
        for route, sec in sorted(self.seconds.items()):
            lines.append(f'opensession_request_seconds_total{{route="{_esc(route)}"}} {sec:.3f}')
        lines += [
            "# HELP opensession_sandbox_events_total Sandbox lifecycle events by kind.",
            "# TYPE opensession_sandbox_events_total counter",
        ]
        for kind, n in sorted(self.event_totals.items()):
            lines.append(f'opensession_sandbox_events_total{{kind="{_esc(kind)}"}} {n}')
        for name, value in gauges.items():
            lines += [f"# TYPE opensession_{name} gauge", f"opensession_{name} {value}"]
        return "\n".join(lines) + "\n"


def _pct(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    i = min(len(sorted_values) - 1, max(0, round(p / 100 * (len(sorted_values) - 1))))
    return sorted_values[i]


def _esc(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"')


def log_request(method: str, route: str, status: int, ms: float) -> None:
    log.info(json.dumps({"method": method, "route": route, "status": status, "ms": round(ms, 1)}))


def host_stats() -> dict:
    """Load and memory of the machine the gateway runs on (Linux /proc; empty elsewhere)."""
    out: dict = {}
    try:
        out["load"] = [round(x, 2) for x in os.getloadavg()]
        out["cpus"] = os.cpu_count()
    except OSError:
        pass
    try:
        mem = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                mem[k] = int(v.split()[0]) // 1024  # MB
        out["memory_mb"] = {"total": mem.get("MemTotal"), "available": mem.get("MemAvailable")}
    except (OSError, ValueError):
        pass
    try:
        st = os.statvfs("/")
        out["disk_mb"] = {"total": st.f_blocks * st.f_frsize // 2**20, "free": st.f_bavail * st.f_frsize // 2**20}
    except OSError:
        pass
    return out
