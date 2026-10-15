#!/usr/bin/env bash
# One-time host setup for OpenSession on an Ubuntu 24.04 VPS (also Debian 12),
# next to Dokploy. Run as root (or with sudo) on the server:
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/opensession/main/scripts/vps/setup-host.sh | sudo bash
#   # or, from a clone:  sudo bash scripts/vps/setup-host.sh
#
# It changes the Docker daemon, which Dokploy does not manage:
#   1. installs gVisor (runsc) and registers it as a Docker runtime, so sandboxes
#      can run with SANDBOX_RUNTIME=runsc (a separate kernel per sandbox);
#   2. adds address pools for bridge networks: every running sandbox gets its own
#      network, and Docker's defaults allow only ~30. 172.20.0.0/14 in /24s = 1024
#      networks, clear of Docker Swarm's 10.0.0.0/8 overlay pool that Dokploy uses.
#
# Docker restarts at the end, which briefly restarts Dokploy and its apps.
# Safe to run again: it only adds what is missing.
set -euo pipefail

POOL_BASE="${POOL_BASE:-172.20.0.0/14}"
POOL_SIZE="${POOL_SIZE:-24}"
DAEMON_JSON=/etc/docker/daemon.json

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is not installed (install Dokploy first)" >&2; exit 1; }
command -v python3 >/dev/null || apt-get install -y python3

echo "== gVisor (runsc)"
if ! command -v runsc >/dev/null; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update -q
  apt-get install -y -q runsc
else
  echo "runsc already installed: $(runsc --version | head -n1)"
fi

echo "== Docker daemon: runsc runtime and address pools"
mkdir -p /etc/docker
[ -f "$DAEMON_JSON" ] && cp "$DAEMON_JSON" "$DAEMON_JSON.bak.$(date +%Y%m%d%H%M%S)"
python3 - "$DAEMON_JSON" "$(command -v runsc)" "$POOL_BASE" "$POOL_SIZE" <<'PY'
import json, os, sys
path, runsc, base, size = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
cfg = {}
if os.path.exists(path) and os.path.getsize(path):
    with open(path) as f:
        cfg = json.load(f)
cfg.setdefault("runtimes", {})["runsc"] = {"path": runsc}
pools = cfg.get("default-address-pools")
if not pools:
    # Keep Docker's usual 172.17.0.0/16 for the default bridge, add ours for the rest.
    cfg["default-address-pools"] = [{"base": "172.17.0.0/16", "size": 16}, {"base": base, "size": size}]
elif not any(p.get("base") == base for p in pools):
    pools.append({"base": base, "size": size})
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(json.dumps(cfg, indent=2))
PY

echo "== restarting Docker (Dokploy restarts with it)"
systemctl restart docker

echo "== checking gVisor"
if docker run --rm --runtime=runsc hello-world >/dev/null 2>&1; then
  echo "ok: containers run under gVisor. Set SANDBOX_RUNTIME=runsc in Dokploy's Environment tab."
else
  echo "WARNING: 'docker run --runtime=runsc' failed. Some VPS kernels/virtualisation need" >&2
  echo "  runsc's ptrace platform: add  \"runtimeArgs\": [\"--platform=ptrace\"]  to the runsc entry in $DAEMON_JSON," >&2
  echo "  restart Docker and run this check again. Until it works, leave SANDBOX_RUNTIME empty." >&2
fi
echo "done."
