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
exec opencode serve --hostname 0.0.0.0 --port 4096
