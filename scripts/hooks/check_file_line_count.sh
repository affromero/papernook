#!/usr/bin/env bash
# Pre-commit hook: keep source files below the line-count limit so modules stay
# focused. Override the limit with PAPERNOOK_MAX_FILE_LINES.

set -euo pipefail

max_lines="${PAPERNOOK_MAX_FILE_LINES:-1000}"
exit_code=0

is_source_file() {
  case "$1" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.css|*.rs|*.swift|*.py|*.sh) return 0 ;;
    *) return 1 ;;
  esac
}

for file in "$@"; do
  [[ -f "$file" ]] || continue
  is_source_file "$file" || continue

  lines=$(wc -l < "$file")

  if (( lines <= max_lines )); then
    continue
  fi

  printf '%s: %s lines exceeds the %s-line file limit. Split related code into a focused module.\n' \
    "$file" "$lines" "$max_lines" >&2
  exit_code=1
done

exit "$exit_code"
