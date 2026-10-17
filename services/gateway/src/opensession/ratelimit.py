"""
Rate limits for the gateway, in memory (the gateway runs as one process).

Each request takes a token from one or two buckets that refill continuously:

- "default": every request from one caller, so a runaway client can't swamp the gateway.
- a rule for costly actions (creating tokens, validating API keys, starting projects,
  prompts, tickets, pull requests): a tighter bucket for that action per caller.

The caller is the credential when there is one (a hash of the Authorization header, or
the dev X-User-Id), else the client address. Requests that fail sign-in (401) also count
against the address; past RATE_LIMIT_AUTH_FAILURES a minute it is refused for a while,
which slows down token guessing. Over a limit the answer is 429 with Retry-After.

Limits are per minute. Override one with RATE_LIMIT_<NAME> (e.g. RATE_LIMIT_PROMPT=30;
0 = no limit for it) and turn them all off with RATE_LIMITS=0.

The client address: behind Dokploy's Traefik every request comes from Traefik, so the
last X-Forwarded-For entry (the one Traefik adds) is used. Sandboxes can't reach this
code with a forged header: their requests are refused before it runs.
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class Rule:
    name: str
    method: str  # "*" for any
    pattern: re.Pattern
    per_minute: int


def _r(name: str, method: str, pattern: str, per_minute: int) -> Rule:
    return Rule(name, method, re.compile(pattern), per_minute)


# First match wins; "default" applies to every request as well.
RULES = [
    _r("tokens", "POST", r"^/tokens$", 10),
    _r("keys", "PUT", r"^/keys/[^/]+$", 20),  # each one calls the provider to validate the key
    _r("projects", "POST", r"^/workspaces$", 10),
    _r("github", "POST", r"^/(github/connect|git/pull-request|git/push)$", 20),
    _r("tickets", "POST", r"^/(terminals/[^/]+/ticket|browser/ticket|preview)$", 60),
    _r("prompt", "POST", r"^/p/[^/]+/api/session/[^/]+/(prompt|command|shell)$", 60),
    _r("sessions", "POST", r"^/p/[^/]+/api/session$", 30),
]
DEFAULT_PER_MINUTE = 3000  # 50 a second: an open workspace is chatty while the agent streams
AUTH_FAILURES_PER_MINUTE = 30
EXEMPT = re.compile(r"^/(health)$")


def _limit(name: str, default: int) -> int:
    v = os.environ.get(f"RATE_LIMIT_{name.upper()}")
    try:
        return max(0, int(v)) if v is not None and v.strip() != "" else default
    except ValueError:
        return default


class RateLimiter:
    def __init__(self) -> None:
        self.enabled = os.environ.get("RATE_LIMITS", "1") != "0"
        self.rules = [Rule(r.name, r.method, r.pattern, _limit(r.name, r.per_minute)) for r in RULES]
        self.default = _limit("default", DEFAULT_PER_MINUTE)
        self.auth_failures = _limit("auth_failures", AUTH_FAILURES_PER_MINUTE)
        # (bucket name, caller) -> (tokens left, last refill time)
        self._buckets: dict[tuple[str, str], tuple[float, float]] = {}
        self._last_sweep = time.monotonic()

    @staticmethod
    def caller(headers, client_host: str | None) -> str:
        auth = headers.get("authorization")
        if auth:
            return "c:" + hashlib.sha256(auth.encode()).hexdigest()[:20]
        dev = headers.get("x-user-id")
        if dev:
            return "u:" + dev[:64]
        return "ip:" + RateLimiter.address(headers, client_host)

    @staticmethod
    def address(headers, client_host: str | None) -> str:
        fwd = headers.get("x-forwarded-for")
        if fwd:
            last = fwd.split(",")[-1].strip()
            if last:
                return last[:64]
        return client_host or "unknown"

    def _take(self, bucket: str, who: str, per_minute: int, cost: float = 1.0) -> float:
        """Takes `cost` tokens; returns 0 if allowed, else seconds until it would be."""
        if per_minute <= 0:
            return 0.0
        now = time.monotonic()
        rate = per_minute / 60.0
        tokens, last = self._buckets.get((bucket, who), (float(per_minute), now))
        tokens = min(float(per_minute), tokens + (now - last) * rate)
        if tokens < cost:
            self._buckets[(bucket, who)] = (tokens, now)
            return (cost - tokens) / rate
        self._buckets[(bucket, who)] = (tokens - cost, now)
        self._sweep(now)
        return 0.0

    def _peek(self, bucket: str, who: str, per_minute: int) -> float:
        """Seconds until a bucket has a token again, without taking one."""
        if per_minute <= 0 or (bucket, who) not in self._buckets:
            return 0.0
        now = time.monotonic()
        tokens, last = self._buckets[(bucket, who)]
        tokens = min(float(per_minute), tokens + (now - last) * (per_minute / 60.0))
        return 0.0 if tokens >= 1 else (1 - tokens) / (per_minute / 60.0)

    def _sweep(self, now: float) -> None:
        """Forgets full buckets now and then, so memory stays bounded."""
        if now - self._last_sweep < 60 or len(self._buckets) < 10_000:
            return
        self._last_sweep = now
        for key, (_, last) in list(self._buckets.items()):
            if now - last > 600:
                del self._buckets[key]

    def check(self, method: str, path: str, headers, client_host: str | None) -> tuple[str, int, float] | None:
        """None if the request may go ahead, else (limit name, per minute, retry after seconds)."""
        if not self.enabled or EXEMPT.match(path):
            return None
        address = self.address(headers, client_host)
        wait = self._peek("auth_failures", address, self.auth_failures)
        if wait:
            return ("auth_failures", self.auth_failures, wait)
        who = self.caller(headers, client_host)
        for rule in self.rules:
            if (rule.method in ("*", method)) and rule.pattern.match(path):
                wait = self._take(rule.name, who, rule.per_minute)
                if wait:
                    return (rule.name, rule.per_minute, wait)
                break
        wait = self._take("default", who, self.default)
        if wait:
            return ("default", self.default, wait)
        return None

    def failed_sign_in(self, headers, client_host: str | None) -> None:
        if self.enabled:
            self._take("auth_failures", self.address(headers, client_host), self.auth_failures)


def too_many(name: str, per_minute: int, wait: float):
    from fastapi.responses import JSONResponse

    seconds = max(1, math.ceil(wait))
    what = "failed sign-ins from this address" if name == "auth_failures" else f"requests ({name})"
    return JSONResponse(
        {"detail": f"Too many {what}: the limit is {per_minute} a minute. Try again in {seconds} s."},
        status_code=429,
        headers={"retry-after": str(seconds)},
    )
