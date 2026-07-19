#!/usr/bin/env bash
# papernook installer: interactive .env setup + docker compose up.
# Mirrors Sotto's install.sh pattern; the AI provider is chosen HERE,
# never hardcoded in the app.

set -euo pipefail

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
echo "How should papernook talk to your AI?"
echo "  1) claude   : Claude Code CLI on this machine (keyless)"
echo "  2) codex    : Codex CLI on this machine (keyless)"
echo "  3) ssh      : Claude Code CLI on another machine, over SSH"
echo "  4) anthropic : Anthropic API key"
echo "  5) openai   : OpenAI API key"
echo "  6) ollama   : Ollama on this machine (keyless)"
echo "  7) llamacpp : llama.cpp server on this machine (keyless)"
echo "  8) vllm     : vLLM server on this machine (keyless)"
read -r -p "Choice [1-8]: " CHOICE < /dev/tty

case "$CHOICE" in
  1)
    read -r -p "Claude model [opus/sonnet/haiku, empty = CLI default]: " M < /dev/tty
    AI_BLOCK='AI_PROVIDER=claude-code'
    [ -n "$M" ] && AI_BLOCK="$AI_BLOCK"$'\n'"CLAUDE_CODE_MODEL=$M"
    ;;
  2)
    read -r -p "Codex model [empty = CLI default]: " M < /dev/tty
    AI_BLOCK='AI_PROVIDER=codex'
    [ -n "$M" ] && AI_BLOCK="$AI_BLOCK"$'\n'"CODEX_MODEL=$M"
    ;;
  3)
    read -r -p "SSH host (user@host): " SSH_HOST < /dev/tty
    read -r -p "Claude model [empty = CLI default]: " M < /dev/tty
    AI_BLOCK=$'AI_PROVIDER=claude-code\n'"CLAUDE_CODE_SSH_HOST=${SSH_HOST}"
    [ -n "$M" ] && AI_BLOCK="$AI_BLOCK"$'\n'"CLAUDE_CODE_MODEL=$M"
    ;;
  4)
    read -r -p "Anthropic API key: " AI_KEY < /dev/tty
    AI_BLOCK=$'AI_PROVIDER=anthropic\n'"ANTHROPIC_API_KEY=${AI_KEY}"
    ;;
  5)
    read -r -p "OpenAI API key: " AI_KEY < /dev/tty
    AI_BLOCK=$'AI_PROVIDER=openai\n'"OPENAI_API_KEY=${AI_KEY}"
    ;;
  6)
    read -r -p "Ollama model (for example qwen3:4b): " M < /dev/tty
    [ -n "$M" ] || { echo "A local model id is required." >&2; exit 1; }
    read -r -p "Ollama URL [http://host.docker.internal:11434]: " ENDPOINT < /dev/tty
    ENDPOINT=${ENDPOINT:-http://host.docker.internal:11434}
    AI_BLOCK=$'AI_PROVIDER=ollama\n'"OLLAMA_HOST=${ENDPOINT}"$'\n'"OLLAMA_MODEL=${M}"
    ;;
  7)
    read -r -p "llama.cpp model id: " M < /dev/tty
    [ -n "$M" ] || { echo "A local model id is required." >&2; exit 1; }
    read -r -p "llama.cpp URL [http://host.docker.internal:8080]: " ENDPOINT < /dev/tty
    ENDPOINT=${ENDPOINT:-http://host.docker.internal:8080}
    AI_BLOCK=$'AI_PROVIDER=llamacpp\n'"LLAMACPP_BASE_URL=${ENDPOINT}"$'\n'"LLAMACPP_MODEL=${M}"
    ;;
  8)
    read -r -p "vLLM model id: " M < /dev/tty
    [ -n "$M" ] || { echo "A local model id is required." >&2; exit 1; }
    read -r -p "vLLM URL [http://host.docker.internal:8000]: " ENDPOINT < /dev/tty
    ENDPOINT=${ENDPOINT:-http://host.docker.internal:8000}
    AI_BLOCK=$'AI_PROVIDER=vllm\n'"VLLM_BASE_URL=${ENDPOINT}"$'\n'"VLLM_MODEL=${M}"
    ;;
  *)
    echo "Unknown choice." >&2
    exit 1
    ;;
esac

read -r -p "WebDAV username for PDF Expert [papers]: " WEBDAV_USER < /dev/tty
WEBDAV_USER=${WEBDAV_USER:-papers}
read -r -p "WebDAV password: " WEBDAV_PASS < /dev/tty
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
    read -r -s -p "Shared Papernook access password (12–200 characters): " PAPERNOOK_PASSWORD < /dev/tty
    echo
    validate_papernook_password "$PAPERNOOK_PASSWORD" || exit 1
    PUBLIC_BLOCK=$'PUBLIC_EXPOSURE=true\n'
    PUBLIC_BLOCK+="PAPERNOOK_PUBLIC_HOST=${PUBLIC_HOST}"$'\n'
    PUBLIC_BLOCK+="PAPERNOOK_PASSWORD=$(dotenv_quote "$PAPERNOOK_PASSWORD")"$'\n'
    PUBLIC_BLOCK+=$'APP_HOST=127.0.0.1\nWEBDAV_HOST=127.0.0.1'
    ;;
esac

{
  echo "$AI_BLOCK"
  echo "WEBDAV_USER=${WEBDAV_USER}"
  echo "WEBDAV_PASS=${WEBDAV_PASS}"
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
