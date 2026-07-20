#!/usr/bin/env bash
# papernook installer: interactive .env setup + docker compose up.
# Mirrors Sotto's install.sh pattern; the AI provider is chosen HERE,
# never hardcoded in the app.

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

for dependency in docker openssl; do
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
  : "${INFISICAL_TOKEN:?set INFISICAL_TOKEN}"
  : "${INFISICAL_PROJECT_ID:?set INFISICAL_PROJECT_ID}"
  command -v infisical >/dev/null || { echo "install the infisical CLI first" >&2; exit 1; }
  infisical export --projectId "$INFISICAL_PROJECT_ID" --env prod --format dotenv > .env
  chmod 600 .env
  echo "Wrote .env from Infisical. Starting the stack…"
  docker compose up -d --build
  echo "papernook is up: http://localhost:3000"
  exit 0
fi

if [ -f .env ]; then
  echo ".env already exists; edit it directly or delete it to rerun setup."
  exit 1
fi

echo "papernook setup"
echo
DETECTED_CHOICE=""
if command -v codex >/dev/null 2>&1 && codex login status >/dev/null 2>&1; then
  DETECTED_CHOICE="2"
  echo "Detected Codex CLI and local authentication."
elif command -v claude >/dev/null 2>&1 && claude auth status >/dev/null 2>&1; then
  DETECTED_CHOICE="1"
  echo "Detected Claude Code CLI and local authentication."
fi
echo
echo "How should papernook talk to your AI?"
echo "  1) claude   : Claude Code CLI on this machine (keyless)"
echo "  2) codex    : Codex CLI on this machine (keyless)"
echo "  3) ssh      : Claude Code CLI on another machine, over SSH"
echo "  4) anthropic : Anthropic API key"
echo "  5) openai   : OpenAI API key"
echo "  6) ollama   : Ollama on this machine (keyless)"
echo "  7) llamacpp : llama.cpp server on this machine (keyless)"
echo "  8) vllm     : vLLM server on this machine (keyless)"
if [ -n "$DETECTED_CHOICE" ]; then
  read -r -p "Choice [${DETECTED_CHOICE}, Enter to accept]: " CHOICE < /dev/tty
  CHOICE=${CHOICE:-$DETECTED_CHOICE}
else
  read -r -p "Choice [1-8]: " CHOICE < /dev/tty
fi

case "$CHOICE" in
  1)
    read -r -p "Claude model [opus/sonnet/haiku, empty = CLI default]: " M < /dev/tty
    AI_BLOCK='AI_PROVIDER=claude-code'
    [ -f "${HOME}/.claude/.credentials.json" ] && AI_BLOCK="$AI_BLOCK"$'\n'"CLAUDE_AUTH_FILE=${HOME}/.claude/.credentials.json"
    [ -n "$M" ] && AI_BLOCK="$AI_BLOCK"$'\n'"CLAUDE_CODE_MODEL=$(dotenv_quote "$M")"
    ;;
  2)
    read -r -p "Codex model [empty = CLI default]: " M < /dev/tty
    AI_BLOCK='AI_PROVIDER=codex'
    [ -f "${HOME}/.codex/auth.json" ] && AI_BLOCK="$AI_BLOCK"$'\n'"CODEX_AUTH_FILE=${HOME}/.codex/auth.json"
    [ -n "$M" ] && AI_BLOCK="$AI_BLOCK"$'\n'"CODEX_MODEL=$(dotenv_quote "$M")"
    ;;
  3)
    read -r -p "SSH host (user@host): " SSH_HOST < /dev/tty
    read -r -p "SSH private key path: " SSH_KEY_FILE < /dev/tty
    read -r -p "SSH known_hosts path [${HOME}/.ssh/known_hosts]: " SSH_KNOWN_HOSTS_FILE < /dev/tty
    SSH_KNOWN_HOSTS_FILE=${SSH_KNOWN_HOSTS_FILE:-${HOME}/.ssh/known_hosts}
    [ -f "$SSH_KEY_FILE" ] || { echo "The SSH private key file does not exist." >&2; exit 1; }
    [ -f "$SSH_KNOWN_HOSTS_FILE" ] || { echo "The SSH known_hosts file does not exist." >&2; exit 1; }
    read -r -p "Claude model [empty = CLI default]: " M < /dev/tty
    AI_BLOCK=$'AI_PROVIDER=claude-code\n'"CLAUDE_CODE_SSH_HOST=$(dotenv_quote "$SSH_HOST")"
    AI_BLOCK="$AI_BLOCK"$'\n'"SSH_KEY_FILE=$(dotenv_quote "$SSH_KEY_FILE")"
    AI_BLOCK="$AI_BLOCK"$'\n'"SSH_KNOWN_HOSTS_FILE=$(dotenv_quote "$SSH_KNOWN_HOSTS_FILE")"
    [ -n "$M" ] && AI_BLOCK="$AI_BLOCK"$'\n'"CLAUDE_CODE_MODEL=$(dotenv_quote "$M")"
    ;;
  4)
    read -r -s -p "Anthropic API key: " AI_KEY < /dev/tty
    echo
    [ -n "$AI_KEY" ] || { echo "An API key is required." >&2; exit 1; }
    AI_BLOCK=$'AI_PROVIDER=anthropic\n'"ANTHROPIC_API_KEY=$(dotenv_quote "$AI_KEY")"
    ;;
  5)
    read -r -s -p "OpenAI API key: " AI_KEY < /dev/tty
    echo
    [ -n "$AI_KEY" ] || { echo "An API key is required." >&2; exit 1; }
    AI_BLOCK=$'AI_PROVIDER=openai\n'"OPENAI_API_KEY=$(dotenv_quote "$AI_KEY")"
    ;;
  6)
    read -r -p "Ollama model (for example qwen3:4b): " M < /dev/tty
    [ -n "$M" ] || { echo "A local model id is required." >&2; exit 1; }
    read -r -p "Ollama URL [http://host.docker.internal:11434]: " ENDPOINT < /dev/tty
    ENDPOINT=${ENDPOINT:-http://host.docker.internal:11434}
    AI_BLOCK=$'AI_PROVIDER=ollama\n'"OLLAMA_HOST=$(dotenv_quote "$ENDPOINT")"$'\n'"OLLAMA_MODEL=$(dotenv_quote "$M")"
    ;;
  7)
    read -r -p "llama.cpp model id: " M < /dev/tty
    [ -n "$M" ] || { echo "A local model id is required." >&2; exit 1; }
    read -r -p "llama.cpp URL [http://host.docker.internal:8080]: " ENDPOINT < /dev/tty
    ENDPOINT=${ENDPOINT:-http://host.docker.internal:8080}
    AI_BLOCK=$'AI_PROVIDER=llamacpp\n'"LLAMACPP_BASE_URL=$(dotenv_quote "$ENDPOINT")"$'\n'"LLAMACPP_MODEL=$(dotenv_quote "$M")"
    ;;
  8)
    read -r -p "vLLM model id: " M < /dev/tty
    [ -n "$M" ] || { echo "A local model id is required." >&2; exit 1; }
    read -r -p "vLLM URL [http://host.docker.internal:8000]: " ENDPOINT < /dev/tty
    ENDPOINT=${ENDPOINT:-http://host.docker.internal:8000}
    AI_BLOCK=$'AI_PROVIDER=vllm\n'"VLLM_BASE_URL=$(dotenv_quote "$ENDPOINT")"$'\n'"VLLM_MODEL=$(dotenv_quote "$M")"
    ;;
  *)
    echo "Unknown choice." >&2
    exit 1
    ;;
esac

read -r -p "WebDAV username for PDF Expert [papers]: " WEBDAV_USER < /dev/tty
WEBDAV_USER=${WEBDAV_USER:-papers}
read -r -s -p "WebDAV password (16+ characters): " WEBDAV_PASS < /dev/tty
echo
if [ "${#WEBDAV_PASS}" -lt 16 ] || [ "${#WEBDAV_PASS}" -gt 200 ]; then
  echo "The WebDAV password must be 16–200 characters." >&2
  exit 1
fi
read -r -p "Expose publicly through a custom domain? [y/N]: " PUBLIC < /dev/tty

PUBLIC_BLOCK=""
case "$PUBLIC" in
  y | Y)
    read -r -p "Public hostname (for example papernook.example.com): " PUBLIC_HOST < /dev/tty
    case "$PUBLIC_HOST" in
      "" | *"://"* | *"/"* | *" "* | *":"*)
        echo "Enter a hostname only, without a scheme, path, port, or spaces." >&2
        exit 1
        ;;
    esac
    read -r -p \
      "Public WebDAV URL (for example https://dav-papernook.example.com): " \
      PUBLIC_WEBDAV_URL < /dev/tty
    validate_public_webdav_url "$PUBLIC_WEBDAV_URL" || exit 1
    read -r -s -p "Shared Papernook access password (12–200 characters): " PAPERNOOK_PASSWORD < /dev/tty
    echo
    validate_papernook_password "$PAPERNOOK_PASSWORD" || exit 1
    if [ "$CHOICE" = "1" ] || [ "$CHOICE" = "2" ] || [ "$CHOICE" = "3" ]; then
      echo "Public deployments cannot use CLI agent providers. Choose an API or tool-free local model provider." >&2
      exit 1
    fi
    PUBLIC_BLOCK=$'PUBLIC_EXPOSURE=true\n'
    PUBLIC_BLOCK+="PAPERNOOK_PUBLIC_HOST=${PUBLIC_HOST}"$'\n'
    PUBLIC_BLOCK+="PAPERNOOK_WEBDAV_URL=$(dotenv_quote "$PUBLIC_WEBDAV_URL")"$'\n'
    PUBLIC_BLOCK+="PAPERNOOK_PASSWORD=$(dotenv_quote "$PAPERNOOK_PASSWORD")"$'\n'
    PUBLIC_BLOCK+=$'APP_HOST=127.0.0.1\nWEBDAV_HOST=127.0.0.1'
    ;;
esac

{
  echo "$AI_BLOCK"
  echo "WEBDAV_USER=$(dotenv_quote "$WEBDAV_USER")"
  echo "WEBDAV_PASS=$(dotenv_quote "$WEBDAV_PASS")"
  echo "SESSION_SECRET=$(openssl rand -hex 32)"
  [ -z "$PUBLIC_BLOCK" ] || echo "$PUBLIC_BLOCK"
} > .env

echo
echo "Wrote .env. Starting the stack…"
docker compose up -d --build
echo
echo "papernook is up:"
echo "  app:    http://localhost:3000  (open it and create your profile)"
echo "  webdav: http://localhost:8080  (PDF Expert → WebDAV, user ${WEBDAV_USER})"
case "$PUBLIC" in
  y | Y)
    echo
    echo "Custom-domain settings are ready for ${PUBLIC_HOST}."
    echo "Configure HTTPS with Caddyfile.example before opening it publicly."
    ;;
esac
