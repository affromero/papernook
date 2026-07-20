#!/usr/bin/env bash

set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Missing .env." >&2; exit 1; }
[ -d data ] || { echo "Missing data directory." >&2; exit 1; }

destination="${1:-backups/papernook-$(date -u +%Y%m%dT%H%M%SZ).tar.gz}"
mkdir -p "$(dirname "$destination")"

restart() {
  docker compose start app webdav >/dev/null
}
trap restart EXIT

docker compose stop app webdav >/dev/null
tar \
  --exclude="data/index.db" \
  --exclude="data/index.db-shm" \
  --exclude="data/index.db-wal" \
  --exclude="data/.locks" \
  -czf "$destination" \
  .env data
chmod 600 "$destination"

echo "Backup written to ${destination}"
