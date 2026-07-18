#!/usr/bin/env bash
# papernook installer: interactive .env setup + docker compose up.
# Mirrors Sotto's install.sh pattern; the AI provider is chosen HERE,
# never hardcoded in the app.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env already exists; edit it directly or delete it to rerun setup."
  exit 1
fi

echo "papernook setup"
echo
echo "How should papernook talk to your AI?"
echo "  1) claude   : Claude Code CLI on this machine (keyless)"
echo "  2) codex    : Codex CLI on this machine (keyless)"
echo "  3) ssh      : Claude Code CLI on another machine, over SSH"
echo "  4) anthropic : Anthropic API key"
echo "  5) openai   : OpenAI API key"
read -r -p "Choice [1-5]: " CHOICE

case "$CHOICE" in
  1) AI_BLOCK='AI_PROVIDER=claude-code' ;;
  2) AI_BLOCK='AI_PROVIDER=codex' ;;
  3)
    read -r -p "SSH host (user@host): " SSH_HOST
    AI_BLOCK=$'AI_PROVIDER=claude-code\n'"CLAUDE_CODE_SSH_HOST=${SSH_HOST}"
    ;;
  4)
    read -r -p "Anthropic API key: " AI_KEY
    AI_BLOCK=$'AI_PROVIDER=anthropic\n'"ANTHROPIC_API_KEY=${AI_KEY}"
    ;;
  5)
    read -r -p "OpenAI API key: " AI_KEY
    AI_BLOCK=$'AI_PROVIDER=openai\n'"OPENAI_API_KEY=${AI_KEY}"
    ;;
  *)
    echo "Unknown choice." >&2
    exit 1
    ;;
esac

read -r -p "WebDAV username for PDF Expert [papers]: " WEBDAV_USER
WEBDAV_USER=${WEBDAV_USER:-papers}
read -r -p "WebDAV password: " WEBDAV_PASS
read -r -p "Expose publicly (forces profile passwords)? [y/N]: " PUBLIC

{
  echo "$AI_BLOCK"
  echo "WEBDAV_USER=${WEBDAV_USER}"
  echo "WEBDAV_PASS=${WEBDAV_PASS}"
  echo "SESSION_SECRET=$(openssl rand -hex 32)"
  case "$PUBLIC" in
    y | Y) echo "PUBLIC_EXPOSURE=true" ;;
  esac
} > .env

echo
echo "Wrote .env. Starting the stack…"
docker compose up -d --build
echo
echo "papernook is up:"
echo "  app:    http://localhost:3000  (open it and create your profile)"
echo "  webdav: http://localhost:8080  (PDF Expert → WebDAV, user ${WEBDAV_USER})"
