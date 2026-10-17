#!/bin/sh
# Applies the user's agent setup (written by the gateway into
# ~/.state/incoming/opensession-config) to OpenCode's config folder, then starts
# OpenCode. Files listed in the previous manifest are removed first, so deleted
# skills/agents/commands disappear; anything else in the folder is left alone.
set -eu
CFG="$HOME/.config/opencode"
IN="$HOME/.state/incoming/opensession-config"
if [ -d "$IN" ]; then
  if [ -f "$CFG/.opensession-managed" ]; then
    while IFS= read -r f; do
      case "$f" in ""|/*|*..*) continue ;; esac
      rm -f "$CFG/$f"
    done < "$CFG/.opensession-managed"
    for d in opensession-skills skills agents commands; do
      [ -d "$CFG/$d" ] && find "$CFG/$d" -mindepth 1 -type d -empty -delete || true
    done
  fi
  mkdir -p "$CFG"
  cp -R "$IN/." "$CFG/"
  rm -rf "$IN"
fi
# /tmp is a noexec tmpfs. OpenCode (a Bun binary) extracts native libraries, e.g. for
# the terminal (PTY), to its temp folder and loads them, which noexec forbids; give it
# a temp folder in the container's own filesystem instead.
export TMPDIR="$HOME/.cache/tmp" BUN_TMPDIR="$HOME/.cache/tmp"
mkdir -p "$TMPDIR" && chmod 700 "$TMPDIR"
# The Browser card's way into the sandbox's Chromium (browser-view.mjs). Restarted with
# OpenCode so it has the current password; it starts Chromium only when the card opens.
if [ -f /usr/local/lib/opensession/browser-view.mjs ]; then
  pkill -f /usr/local/lib/opensession/browser-view.mjs 2>/dev/null || true
  mkdir -p "$HOME/.cache"
  nohup node /usr/local/lib/opensession/browser-view.mjs >"$HOME/.cache/browser-view.log" 2>&1 &
fi
exec opencode serve --hostname 0.0.0.0 --port 4096
