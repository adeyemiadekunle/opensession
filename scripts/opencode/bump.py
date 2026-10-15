"""
Move OpenSession to another OpenCode release, in every place it is pinned.

    python scripts/opencode/bump.py 2.0.31 [--openapi NEW_OPENAPI.json]

Run it only for a release that passed the update check (api_check.py and the
smoke test; .github/workflows/opencode-update.yml does all of it). It updates:
opencode-version.json, the sandbox Dockerfile, docker-compose.dokploy.yml, the
gateway's and the TypeScript client's approved lists, and stores the release's
OpenAPI document in docs/reference/ as the new reference.
tests/test_opencode_version.py fails if any of them is left behind.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")


def sub(path: Path, pattern: str, repl: str, count: int = 0) -> None:
    text = path.read_text(encoding="utf-8")
    new, n = re.subn(pattern, repl, text, count=count, flags=re.M)
    if n == 0:
        raise SystemExit(f"{path}: pattern not found: {pattern}")
    path.write_text(new, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("version")
    ap.add_argument("--openapi", help="the release's OpenAPI document, kept as docs/reference/opencode-<version>-openapi.json")
    a = ap.parse_args(argv)
    v = a.version.lstrip("v")
    if not VERSION_RE.match(v):
        print(f"not a version: {a.version}", file=sys.stderr)
        return 2

    pinned_path = ROOT / "opencode-version.json"
    pinned = json.loads(pinned_path.read_text(encoding="utf-8"))
    old = pinned["version"]
    pinned.update(version=v, supported=[v])
    pinned_path.write_text(json.dumps(pinned, indent=2) + "\n", encoding="utf-8")

    sub(ROOT / "services/sandbox/Dockerfile", r"^ARG OPENCODE_VERSION=\S+$", f"ARG OPENCODE_VERSION={v}")
    sub(ROOT / "docker-compose.dokploy.yml", r"\$\{OPENCODE_VERSION:-[^}]+\}", "${OPENCODE_VERSION:-" + v + "}")
    sub(
        ROOT / "services/gateway/src/opensession/opencode_version.py",
        r"^SUPPORTED_OPENCODE_VERSIONS: tuple\[str, \.\.\.\] = \([^)]*\)$",
        f'SUPPORTED_OPENCODE_VERSIONS: tuple[str, ...] = ("{v}",)',
    )
    sub(
        ROOT / "packages/api-client/src/types.ts",
        r"^export const SUPPORTED_OPENCODE_VERSIONS: readonly string\[\] = \[[^\]]*\];$",
        f'export const SUPPORTED_OPENCODE_VERSIONS: readonly string[] = ["{v}"];',
    )
    if a.openapi:
        shutil.copyfile(a.openapi, ROOT / "docs/reference" / f"opencode-{v}-openapi.json")
    print(f"OpenCode {old} -> {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
