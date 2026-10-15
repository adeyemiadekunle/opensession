# Sandbox image: OpenCode V2 server + common toolchains, running as a non-root user.
#
# Build (from the repo root):
#   docker build -t opencode-sandbox:latest services/sandbox
#
# OpenCode V2 is installed with its official installer (https://opencode.ai/v2/install),
# as the agent user, at exactly OPENCODE_VERSION: the build fails rather than install
# another release, since the V2 HTTP API is still changing. The version is approved in
# /opencode-version.json and changes only through the update check
# (docs/OPENCODE-UPDATES.md, scripts/opencode/bump.py).

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates openssh-client ripgrep jq unzip \
      python3 python3-pip python3-venv build-essential \
 && rm -rf /var/lib/apt/lists/*

# Non-root user; /workspace is the persistent volume mounted by the orchestrator.
# The node base image already has a "node" user with UID 1000; rename it to "agent".
RUN usermod --login agent --home /home/agent --move-home node \
 && groupmod --new-name agent node \
 && mkdir -p /workspace \
 && chown agent:agent /workspace
USER agent
WORKDIR /workspace
ENV HOME=/home/agent

# Commits the agent makes are attributed to this identity (the user pushes them
# through OpenSession with their GitHub connection).
RUN git config --global user.name "OpenSession Agent" \
 && git config --global user.email "agent@users.noreply.opensession.dev" \
 && git config --global init.defaultBranch main

# OpenCode's data (session database) and config live under /home/agent/.state,
# which the orchestrator mounts as a per-sandbox volume so they survive rebuilds.
RUN mkdir -p /home/agent/.state/data /home/agent/.state/config \
             /home/agent/.local/share /home/agent/.config \
 && ln -s /home/agent/.state/data /home/agent/.local/share/opencode \
 && ln -s /home/agent/.state/config /home/agent/.config/opencode

ARG OPENCODE_VERSION=2.0.0
RUN curl -fsSL https://opencode.ai/v2/install -o /tmp/oc-install.sh \
 && bash /tmp/oc-install.sh --version "${OPENCODE_VERSION}" \
 && mkdir -p /home/agent/.local/bin \
 && OC="$(command -v opencode || find /home/agent -type f -name opencode -perm -u+x | head -n1)" \
 && test -n "$OC" \
 && ln -sf "$OC" /home/agent/.local/bin/opencode \
 && got="$(/home/agent/.local/bin/opencode --version | awk 'END { print $NF }')" && got="${got#v}" \
 && { [ "$got" = "${OPENCODE_VERSION}" ] || { echo "installed OpenCode $got, expected ${OPENCODE_VERSION}" >&2; exit 1; }; } \
 && rm /tmp/oc-install.sh
ENV PATH=/home/agent/.local/bin:/home/agent/.opencode/bin:$PATH

EXPOSE 4096

# Applies the user's agent setup (skills, agents, commands, MCP, permissions), then
# runs `opencode serve` in the foreground.
COPY --chmod=755 entrypoint.sh /usr/local/bin/opensession-entrypoint
CMD ["/usr/local/bin/opensession-entrypoint"]
