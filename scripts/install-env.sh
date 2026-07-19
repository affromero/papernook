dotenv_quote() {
  local value="${1-}"
  local escaped=""
  local char
  local index
  for ((index = 0; index < ${#value}; index++)); do
    char="${value:index:1}"
    case "$char" in
      \\) escaped+="\\\\" ;;
      "'") escaped+="\\'" ;;
      *) escaped+="$char" ;;
    esac
  done
  printf "'%s'" "$escaped"
}

validate_papernook_password() {
  local value="${1-}"
  if [ "${#value}" -lt 12 ]; then
    echo "The shared access password must be at least 12 characters." >&2
    return 1
  fi
  if [ "${#value}" -gt 200 ]; then
    echo "The shared access password must be at most 200 characters." >&2
    return 1
  fi
}
