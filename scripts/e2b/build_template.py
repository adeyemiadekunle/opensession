"""
Build the OpenSession sandbox image as an E2B template (for SANDBOX_PROVIDER=e2b).

    pip install "e2b>=2.56,<3"
    E2B_API_KEY=... python scripts/e2b/build_template.py [--name opensession-sandbox]

It builds services/sandbox/Dockerfile (the same image the Docker provider runs) on
E2B. The image's CMD is not used: the gateway starts OpenCode itself, with each
user's keys, after creating or resuming a sandbox. Re-run after changing the
Dockerfile or OPENCODE_VERSION; the template name must match E2B_TEMPLATE.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTEXT = ROOT / "services" / "sandbox"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--name", default=os.environ.get("E2B_TEMPLATE", "opensession-sandbox"))
    ap.add_argument("--cpus", type=int, default=2)
    ap.add_argument("--memory-mb", type=int, default=2048)
    args = ap.parse_args()
    if not os.environ.get("E2B_API_KEY"):
        print("set E2B_API_KEY first", file=sys.stderr)
        return 2
    from e2b import Template, default_build_logger

    template = Template(file_context_path=str(CONTEXT)).from_dockerfile(str(CONTEXT / "Dockerfile"))
    info = Template.build(
        template,
        args.name,
        cpu_count=args.cpus,
        memory_mb=args.memory_mb,
        on_build_logs=default_build_logger(),
    )
    print(f"built template {args.name}: {info}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
