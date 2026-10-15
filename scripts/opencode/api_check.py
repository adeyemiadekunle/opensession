"""
Is an OpenCode release's HTTP API still what OpenSession uses?

    python scripts/opencode/api_check.py NEW_OPENAPI.json [--reference OLD_OPENAPI.json]

NEW_OPENAPI.json is the release's own description (GET /openapi.json on a running
`opencode serve`). Fails (exit 1) if any endpoint OpenSession calls is missing;
with --reference it also lists endpoints added and removed since the approved
version, for the update PR. Used by .github/workflows/opencode-update.yml.

Keep REQUIRED in step with the code: the gateway (gateway.py, orchestrator.py,
opencode_proxy.py), packages/api-client (opencode.ts, local.ts) and the terminal.
"""

from __future__ import annotations

import argparse
import json
import sys

# (method, path as written in OpenCode's OpenAPI document)
REQUIRED: list[tuple[str, str]] = [
    ("GET", "/api/health"),
    # sessions and the agent loop
    ("GET", "/api/session"),
    ("POST", "/api/session"),
    ("GET", "/api/session/active"),  # sleep: is an agent still working?
    ("GET", "/api/session/{sessionID}"),
    ("DELETE", "/api/session/{sessionID}"),
    ("POST", "/api/session/{sessionID}/prompt"),
    ("POST", "/api/session/{sessionID}/wait"),
    ("POST", "/api/session/{sessionID}/interrupt"),
    ("POST", "/api/session/{sessionID}/command"),
    ("POST", "/api/session/{sessionID}/skill"),
    ("POST", "/api/session/{sessionID}/shell"),
    ("POST", "/api/session/{sessionID}/agent"),
    ("POST", "/api/session/{sessionID}/model"),
    ("GET", "/api/session/{sessionID}/message"),
    ("GET", "/api/experimental/session/{sessionID}/log"),  # live events (SSE)
    ("GET", "/api/session/{sessionID}/permission"),
    ("POST", "/api/session/{sessionID}/permission/{requestID}/reply"),
    ("GET", "/api/session/{sessionID}/form"),
    ("POST", "/api/session/{sessionID}/form/{formID}/reply"),
    # catalog
    ("GET", "/api/model"),
    ("GET", "/api/agent"),
    ("GET", "/api/skill"),
    ("GET", "/api/command"),
    # files and git
    ("GET", "/api/fs/list"),
    ("GET", "/api/fs/read/*"),
    ("GET", "/api/vcs"),
    ("GET", "/api/vcs/status"),
    ("GET", "/api/vcs/branches"),
    ("GET", "/api/vcs/diff"),
    # terminal
    ("GET", "/api/pty"),
    ("POST", "/api/pty"),
    ("GET", "/api/pty/{ptyID}"),
    ("PUT", "/api/pty/{ptyID}"),
    ("DELETE", "/api/pty/{ptyID}"),
    ("GET", "/api/pty/{ptyID}/connect"),
    # local mode: keys saved in OpenCode itself
    ("POST", "/api/integration/{integrationID}/connect/key"),
    ("GET", "/api/provider"),
]

METHODS = ("get", "post", "put", "patch", "delete")


def endpoints(spec: dict) -> set[tuple[str, str]]:
    return {(m.upper(), path) for path, ops in (spec.get("paths") or {}).items() for m in ops if m in METHODS}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("spec", help="the new release's OpenAPI document")
    ap.add_argument("--reference", help="the approved release's OpenAPI document")
    a = ap.parse_args(argv)
    with open(a.spec, encoding="utf-8") as f:
        new = endpoints(json.load(f))
    if not new:
        print(f"{a.spec}: no endpoints found (not an OpenAPI document?)", file=sys.stderr)
        return 1
    missing = [e for e in REQUIRED if e not in new]
    print(f"{len(new)} endpoints; {len(REQUIRED) - len(missing)}/{len(REQUIRED)} that OpenSession uses are present.")
    if a.reference:
        with open(a.reference, encoding="utf-8") as f:
            old = endpoints(json.load(f))
        for label, items in (("Added", sorted(new - old)), ("Removed", sorted(old - new))):
            print(f"\n{label} since the approved version ({len(items)}):")
            for m, p in items:
                used = "  <- used by OpenSession" if (m, p) in REQUIRED else ""
                print(f"  {m:6} {p}{used}")
    if missing:
        print("\nMISSING (OpenSession calls these):", file=sys.stderr)
        for m, p in missing:
            print(f"  {m:6} {p}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
