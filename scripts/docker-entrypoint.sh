#!/usr/bin/env sh

set -eu

copy_auth_dir() {
  source_dir="$1"
  target_dir="$2"
  label="$3"
  if [ -d "$source_dir" ] && [ -n "$(ls -A "$source_dir" 2>/dev/null)" ]; then
    mkdir -p "$target_dir"
    if cp -R "$source_dir"/. "$target_dir"/ 2>/dev/null; then
      echo "[setup] Copied ${label} authentication from the host"
    else
      echo "[setup] WARNING: ${label} authentication files are not readable"
    fi
  fi
}

copy_auth_dir /root/.codex-host /root/.codex "Codex"
copy_auth_dir /root/.claude-host /root/.claude "Claude Code"

exec "$@"
