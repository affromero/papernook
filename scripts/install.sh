#!/usr/bin/env bash
# papernook installer: deployment setup + docker compose up.

set -euo pipefail
umask 077

# Self-bootstrap: when run via `curl … | bash` there is no repo around the
# script, so clone it and re-exec from the clone.
if [ -f "$(dirname "$0")/../docker-compose.yml" ]; then
  cd "$(dirname "$0")/.."
else
  command -v git >/dev/null || { echo "install git first" >&2; exit 1; }
  echo "Cloning papernook…"
  git clone https://github.com/affromero/papernook.git
  cd papernook
  exec ./scripts/install.sh "$@"
fi

# Loaded only after the self-bootstrap above has entered the cloned repo.
source ./scripts/install-env.sh

print_owner_claim() {
  local listing owner_count claim code
  listing=$(./scripts/papernook access list)
  owner_count=$(printf '%s' "$listing" | python3 -c 'import json,sys; print(sum(p.get("role") == "owner" for p in json.load(sys.stdin)["principals"]))')
  [ "$owner_count" = 0 ] || return 0
  claim=$(./scripts/papernook access claim)
  code=$(printf '%s' "$claim" | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
  echo "Owner claim code (valid for 15 minutes): $code"
  echo "Open the app and enter this code to create the owner account."
}

for dependency in docker openssl python3; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "install ${dependency} before running setup" >&2
    exit 1
  }
done
docker compose version >/dev/null 2>&1 || {
  echo "install the Docker Compose plugin before running setup" >&2
  exit 1
}

# Non-interactive: pull everything from an existing Infisical project.
#   INFISICAL_TOKEN=... INFISICAL_PROJECT_ID=... ./scripts/install.sh --from-infisical
if [ "${1:-}" = "--from-infisical" ]; then
  [ ! -f .env ] || { echo ".env already exists; use papernook update." >&2; exit 1; }
  : "${INFISICAL_TOKEN:?set INFISICAL_TOKEN}"
  : "${INFISICAL_PROJECT_ID:?set INFISICAL_PROJECT_ID}"
  command -v infisical >/dev/null || { echo "install the infisical CLI first" >&2; exit 1; }
  infisical export --projectId "$INFISICAL_PROJECT_ID" --env prod --format dotenv > .env
  chmod 600 .env
  echo "Wrote .env from Infisical. Starting the stack…"
  bash ./scripts/runtime/start-stack.sh build
  ./scripts/papernook link || true
  echo "Papernook is up at the configured PAPERNOOK_URL (default http://localhost:3000)."
  print_owner_claim
  exit 0
fi

if [ -f .env ]; then
  echo ".env already exists; edit it directly or delete it to rerun setup."
  exit 1
fi

echo "papernook setup"
echo
echo "AI providers, models, endpoints, and credentials are configured in browser setup."

read -r -p "WebDAV username for PDF Expert [papers]: " WEBDAV_USER < /dev/tty
WEBDAV_USER=${WEBDAV_USER:-papers}
read -r -s -p "WebDAV password (16+ characters): " WEBDAV_PASS < /dev/tty
echo
if [ "${#WEBDAV_PASS}" -lt 16 ] || [ "${#WEBDAV_PASS}" -gt 200 ]; then
  echo "The WebDAV password must be 16–200 characters." >&2
  exit 1
fi
read -r -p "App URL used in your browser [http://localhost:3000]: " PAPERNOOK_URL < /dev/tty
PAPERNOOK_URL=${PAPERNOOK_URL:-http://localhost:3000}
echo "Use a stable HTTPS hostname for passkeys on your other devices."

read -r -p "Expose publicly through a custom domain? [y/N]: " PUBLIC < /dev/tty

PUBLIC_BLOCK=""
case "$PUBLIC" in
  y | Y)
    read -r -p \
      "Public WebDAV URL (for example https://dav-papernook.example.com): " \
      PUBLIC_WEBDAV_URL < /dev/tty
    validate_public_webdav_url "$PUBLIC_WEBDAV_URL" || exit 1
    PUBLIC_BLOCK="PAPERNOOK_WEBDAV_URL=$(dotenv_quote "$PUBLIC_WEBDAV_URL")"
    ;;
esac

{
  echo "WEBDAV_USER=$(dotenv_quote "$WEBDAV_USER")"
  echo "WEBDAV_PASS=$(dotenv_quote "$WEBDAV_PASS")"
  echo "PAPERNOOK_URL=$(dotenv_quote "$PAPERNOOK_URL")"
  echo "SESSION_SECRET=$(openssl rand -hex 32)"
  [ -z "$PUBLIC_BLOCK" ] || echo "$PUBLIC_BLOCK"
} > .env

echo
echo "Wrote .env. Starting the stack…"
bash ./scripts/runtime/start-stack.sh build
# The `papernook` command lives on PATH so updates are one word, not a
# remembered path into the clone.
./scripts/papernook link || true

echo
echo "papernook is up:"
echo "  app:    ${PAPERNOOK_URL}"
echo "  webdav: http://localhost:8080  (PDF Expert → WebDAV, user ${WEBDAV_USER})"
print_owner_claim
echo "Then configure AI and register a passkey in the browser."
case "$PUBLIC" in
  y | Y)
    echo
    echo "Custom-domain settings are ready."
    echo "Configure HTTPS with Caddyfile.example before opening it publicly."
    ;;
esac
