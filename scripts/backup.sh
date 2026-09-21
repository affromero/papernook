#!/usr/bin/env bash

set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Missing .env." >&2; exit 1; }
[ -d data ] || { echo "Missing data directory." >&2; exit 1; }

already_stopped=0
if [ "${1:-}" = --stopped ]; then
  already_stopped=1
  shift
fi
destination="${1:-backups/papernook-$(date -u +%Y%m%dT%H%M%SZ).tar.gz}"
mkdir -p "$(dirname "$destination")"

running=()
restart() {
  if [ "${#running[@]}" -gt 0 ]; then
    docker compose start "${running[@]}" >/dev/null
  fi
}
for service in app webdav; do
  containers=$(docker compose ps --status running --quiet "$service")
  if [ -n "$containers" ]; then
    if [ "$already_stopped" = 1 ]; then
      echo "Backup requires stopped writers: $service is running." >&2
      exit 1
    fi
    running+=("$service")
  fi
done
if [ "$already_stopped" = 0 ]; then
  trap restart EXIT
  docker compose stop app webdav >/dev/null
fi
tar \
  --exclude="data/index.db" \
  --exclude="data/index.db-shm" \
  --exclude="data/index.db-wal" \
  --exclude="data/.locks" \
  -czf "$destination" \
  .env data
chmod 600 "$destination"

echo "Backup written to ${destination}"
