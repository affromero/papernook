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

# Credentials are seeded, never synced: the CLIs rotate their refresh token in
# place and the host copy is read-only, so restoring an older snapshot over a
# rotation hands back a retired token. The helper installs only what is newer
# and never deletes; signing out stays an explicit action through the reload
# endpoint. The comparison needs a JSON parse, which no POSIX shell can do
# honestly and jq is not in this image.
seed_credentials() {
  node /app/scripts/agent/seed-cli-credentials.mjs "$1" "$2" "$3" || \
    echo "[setup] WARNING: could not seed $1 credentials"
}

seed_credentials codex /run/cli-credentials/codex-auth.json "${CODEX_HOME:-/home/node/.codex}/auth.json"
seed_credentials claude-code /run/cli-credentials/claude-credentials.json "${CLAUDE_HOME:-/home/node}/.claude/.credentials.json"
copy_auth_file /run/host-auth/ssh-key /home/node/.ssh/id_papernook "SSH key"
copy_auth_file /run/host-auth/known-hosts /home/node/.ssh/known_hosts "SSH known_hosts"

chown -R node:node /data /home/node/.codex /home/node/.claude /home/node/.ssh
exec gosu node "$@"
