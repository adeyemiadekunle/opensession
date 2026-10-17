# Sandbox image: OpenCode V2 server + common toolchains, running as a non-root user.
#
# Build (from the repo root):
#   docker build -t opencode-sandbox:latest --build-arg OPENCODE_VERSION=2.0.0 services/sandbox/
#
# OpenCode V2 is installed with its official installer (https://opencode.ai/v2/install),
# as the agent user. Re-run scripts/check after changing OPENCODE_VERSION: the V2
# HTTP API is new and still changing.

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates openssh-client ripgrep jq unzip procps \
      python3 python3-pip python3-venv build-essential \
 && rm -rf /var/lib/apt/lists/*

# Browser for the agent: Playwright MCP attached to one Chromium per sandbox
# (chromium.sh, browser-mcp.sh), its live view for the Browser card (browser-view.mjs,
# port 9223), and the tools that need the user: asking for a domain and handing the
# browser over for a sign-in (opensession-mcp.mjs).
# Chromium's system libraries and fonts come with --with-deps.
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN mkdir -p /opt/opensession/browser \
 && npm install --prefix /opt/opensession/browser --no-audit --no-fund "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && /opt/opensession/browser/node_modules/.bin/playwright install --with-deps --no-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache
COPY --chmod=755 chromium.sh /usr/local/bin/opensession-chromium
COPY --chmod=755 browser-mcp.sh /usr/local/bin/opensession-browser
COPY --chmod=644 opensession-mcp.mjs browser-view.mjs /usr/local/lib/opensession/

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

# Build the CLI and desktop app with the same OPENCODE_VERSION (the Release workflow's
# repository variable), so local mode runs the version the sandbox does.
ARG OPENCODE_VERSION=2.0.0
RUN curl -fsSL https://opencode.ai/v2/install -o /tmp/oc-install.sh \
 && (bash /tmp/oc-install.sh --version "${OPENCODE_VERSION}" || bash /tmp/oc-install.sh) \
 && mkdir -p /home/agent/.local/bin \
 && OC="$(command -v opencode || find /home/agent -type f -name opencode -perm -u+x | head -n1)" \
 && test -n "$OC" \
 && ln -sf "$OC" /home/agent/.local/bin/opencode \
 && /home/agent/.local/bin/opencode --version \
 && rm /tmp/oc-install.sh
ENV PATH=/home/agent/.local/bin:/home/agent/.opencode/bin:$PATH

EXPOSE 4096

# Applies the user's agent setup (skills, agents, commands, MCP, permissions), then
# runs `opencode serve` in the foreground.
COPY --chmod=755 entrypoint.sh /usr/local/bin/opensession-entrypoint
CMD ["/usr/local/bin/opensession-entrypoint"]
