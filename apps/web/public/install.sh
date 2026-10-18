#!/bin/sh
# Installs the OpenSession CLI (`opensession`) for the current user on macOS or Linux:
#
#   curl -fsSL https://<your web app>/install.sh | sh
#
# Needs Node.js 20 or newer. Downloads opensession.mjs (one file, your deployment's
# addresses built in) from the latest GitHub release into ~/.local/share/opensession and
# puts an `opensession` command in ~/.local/bin. Run it again to update.
#
#   OPENSESSION_VERSION=v0.2.0      a specific release instead of the latest
#   OPENSESSION_INSTALL_DIR=/path   where the command goes (default ~/.local/bin)
#   OPENSESSION_REPO=owner/repo     the GitHub repository with the releases
#   OPENSESSION_DOWNLOAD_URL=url    download opensession.mjs from here instead
set -eu

REPO="${OPENSESSION_REPO:-adeyemiadekunle/opensession}"
VERSION="${OPENSESSION_VERSION:-latest}"
BIN_DIR="${OPENSESSION_INSTALL_DIR:-$HOME/.local/bin}"
LIB_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opensession"

fail() {
  echo "opensession install: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is needed: https://nodejs.org"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || fail "Node.js $(node -v) found; OpenSession needs 20 or newer: https://nodejs.org"

if [ -n "${OPENSESSION_DOWNLOAD_URL:-}" ]; then
  URL="$OPENSESSION_DOWNLOAD_URL"
elif [ "$VERSION" = latest ]; then
  URL="https://github.com/$REPO/releases/latest/download/opensession.mjs"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/opensession.mjs"
fi

mkdir -p "$BIN_DIR" "$LIB_DIR"
tmp="$LIB_DIR/opensession.mjs.download"
echo "Downloading $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$tmp" || fail "download failed"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$URL" || fail "download failed"
else
  fail "curl or wget is needed"
fi
head -n 1 "$tmp" | grep -q '^#!/usr/bin/env node' || { rm -f "$tmp"; fail "that doesn't look like the OpenSession CLI ($URL)"; }
mv "$tmp" "$LIB_DIR/opensession.mjs"

cat >"$BIN_DIR/opensession" <<EOF
#!/bin/sh
exec node "$LIB_DIR/opensession.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/opensession"

echo "Installed opensession $("$BIN_DIR/opensession" --version) in $BIN_DIR"

# The agent runtime (OpenCode) for local mode: OpenSession installs its own copy.
"$BIN_DIR/opensession" opencode install --postinstall || echo "OpenCode will be downloaded on the first local run."
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "$BIN_DIR is not on your PATH yet. Add it, then open a new terminal:"
    echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile"
    ;;
esac
echo
echo "Next, in a terminal in your project folder:"
echo "  opensession local key anthropic   # once: a model API key (any provider OpenCode supports)"
echo "  opensession                       # chat with the agent in this folder"
echo "To use your cloud projects too: opensession login"
