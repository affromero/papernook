#!/usr/bin/env bash

set -euo pipefail
umask 077

cd "$(dirname "$0")/../.."
prepare=${1:?Expected build or pull}
backup=${2:-backup}
case "$prepare:$backup" in
  build:backup | build:no-backup | pull:backup | pull:no-backup) ;;
  *) echo "Usage: start-stack.sh build|pull [backup|no-backup]" >&2; exit 1 ;;
esac

# Resolve once into a private file, preserving the Compose project name and
# absolute mount paths. The resolved environment may contain credentials.
prepared=$(mktemp)
snapshot=""
stopped=0
failed() {
  local result=$?
  if [ "$result" -ne 0 ] && [ "$stopped" = 1 ]; then
    if docker compose --project-directory "$PWD" -f "$prepared" stop app webdav; then
      echo "Startup failed. App and WebDAV remain stopped." >&2
      echo "Fix the reported error and retry this deployment." >&2
      [ -z "$snapshot" ] || echo "Pre-initialization backup: $snapshot" >&2
    else
      echo "Could not stop all writers. Stop app and WebDAV before recovery." >&2
    fi
  fi
  rm -f "$prepared"
  return "$result"
}
trap failed EXIT
docker compose config --format json > "$prepared"
compose() {
  docker compose --project-directory "$PWD" -f "$prepared" "$@"
}

# Prepare before stopping the current app, including sidecars on fresh hosts.
if [ "$prepare" = pull ]; then
  compose pull app
else
  compose build app
fi
compose pull --ignore-buildable
docker volume create agent-claude-home >/dev/null
docker volume create agent-codex-home >/dev/null

# Freeze every prepared image so a concurrent tag update cannot change the
# code used for initialization, startup, or sidecar writes.
python3 - "$prepared" <<'PY'
import json
import subprocess
import sys

filename = sys.argv[1]
with open(filename) as source:
    configuration = json.load(source)
resolved = json.loads(subprocess.check_output(
    ["docker", "compose", "--project-directory", ".", "-f", filename,
     "config", "--format", "json"], text=True,
))
if resolved != configuration:
    raise RuntimeError("Compose changed the frozen configuration; writers have not been stopped")
for service in configuration["services"].values():
    image = subprocess.check_output(
        ["docker", "image", "inspect", "--format", "{{.Id}}", service["image"]],
        text=True,
    ).strip()
    if not image.startswith("sha256:"):
        raise RuntimeError("Prepared image did not resolve to an immutable ID")
    service["image"] = image
    service["pull_policy"] = "never"
    service.pop("build", None)
with open(filename, "w") as target:
    json.dump(configuration, target)
PY
compose run --rm --no-deps --pull never --entrypoint node app scripts/access.cjs validate-config
stopped=1
compose stop app webdav

if [ "$backup" = backup ] && [ -d data ]; then
  destination="backups/papernook-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
  COMPOSE_FILE="$prepared" bash ./scripts/backup.sh --stopped "$destination"
  snapshot="$destination"
fi

compose run --rm --no-deps --pull never app node scripts/access.cjs initialize
compose up -d --no-build --pull never --wait --wait-timeout 90
stopped=0
