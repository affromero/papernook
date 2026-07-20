#!/usr/bin/env sh

set -eu

copy_auth_file() {
  source_file="$1"
  target_file="$2"
  label="$3"
  if [ -f "$source_file" ] && [ -s "$source_file" ]; then
    mkdir -p "$(dirname "$target_file")"
    if cp "$source_file" "$target_file" 2>/dev/null; then
      chmod 600 "$target_file"
      echo "[setup] Copied ${label} authentication from the host"
    else
      echo "[setup] WARNING: ${label} authentication files are not readable"
    fi
  fi
}

copy_auth_file /run/host-auth/codex-auth.json /home/node/.codex/auth.json "Codex"
copy_auth_file /run/host-auth/claude-credentials.json /home/node/.claude/.credentials.json "Claude Code"
copy_auth_file /run/host-auth/ssh-key /home/node/.ssh/id_papernook "SSH key"
copy_auth_file /run/host-auth/known-hosts /home/node/.ssh/known_hosts "SSH known_hosts"

chown -R node:node /data /home/node/.codex /home/node/.claude /home/node/.ssh
exec gosu node "$@"
