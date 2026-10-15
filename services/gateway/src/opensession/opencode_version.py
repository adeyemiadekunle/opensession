"""
The OpenCode releases this gateway works with.

OpenSession talks to OpenCode V2's HTTP API, which OpenCode still calls
experimental, so a new release can break it. Sandboxes reporting any other
version are refused (orchestrator) instead of failing in odd ways later.

Kept in sync with /opencode-version.json by scripts/opencode/bump.py (and checked
by tests/test_opencode_version.py). OPENCODE_SUPPORTED_VERSIONS overrides it
(comma separated; "*" accepts any version, for trying a new release by hand).
"""

from __future__ import annotations

import os

SUPPORTED_OPENCODE_VERSIONS: tuple[str, ...] = ("2.0.0",)


def supported_versions() -> tuple[str, ...] | None:
    """Allowed versions, or None when any version is accepted."""
    raw = os.environ.get("OPENCODE_SUPPORTED_VERSIONS", "").strip()
    if raw == "*":
        return None
    if raw:
        return tuple(v.strip() for v in raw.split(",") if v.strip())
    return SUPPORTED_OPENCODE_VERSIONS


def version_problem(reported: str | None, allowed: tuple[str, ...] | None) -> str | None:
    """Why a sandbox's OpenCode may not be used, or None if it may."""
    if allowed is None:
        return None
    v = (reported or "").strip().lstrip("v")
    if not v:
        return f"OpenCode did not report its version; this gateway works with OpenCode {', '.join(allowed)}"
    if v not in allowed:
        return (
            f"the sandbox runs OpenCode {v}, but this gateway works with OpenCode {', '.join(allowed)}. "
            "Rebuild the sandbox image with that version (OPENCODE_VERSION), or approve the new one "
            "with the update check (docs/OPENCODE-UPDATES.md)"
        )
    return None
