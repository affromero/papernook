#!/usr/bin/env bash
# Pre-commit hook: every script with a shebang should be executable.

set -euo pipefail

exit_code=0

for file in "$@"; do
  [[ -f "$file" ]] || continue
  first_line=$(head -n 1 "$file" 2>/dev/null || true)
  [[ "$first_line" == '#!'* ]] || continue
  if [[ ! -x "$file" ]]; then
    printf '%s: has a shebang but is not executable. Run chmod +x %q.\n' \
      "$file" "$file" >&2
    exit_code=1
  fi
done

exit "$exit_code"
