#!/usr/bin/env bash
# Pre-commit hook: block committing local env/secrets files while allowing
# documented examples and mock fixtures.

set -euo pipefail

exit_code=0

is_allowed_env_file() {
  case "$1" in
    .env.example|.env.oss.example|.env.mock.local) return 0 ;;
    */.env.example|*/.env.oss.example|*/.env.mock.local) return 0 ;;
    *) return 1 ;;
  esac
}

for file in "$@"; do
  case "$file" in
    *.pem|*.key|*id_rsa*|*id_ed25519*)
      printf '%s: secret-looking key files must not be committed.\n' "$file" >&2
      exit_code=1
      ;;
    .env|.env.*|*/.env|*/.env.*)
      if ! is_allowed_env_file "$file"; then
        printf '%s: local env files must not be committed. Add an example file instead.\n' \
          "$file" >&2
        exit_code=1
      fi
      ;;
  esac
done

exit "$exit_code"
