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

validate_public_webdav_url() {
  local value="${1-}"
  local authority
  local host
  local port
  local label
  local labels

  case "$value" in
    https://*) ;;
    *)
      echo "Enter a public HTTPS URL for the WebDAV endpoint." >&2
      return 1
      ;;
  esac
  case "$value" in
    *[[:space:]]* | *"@"* | *"?"* | *"#"*)
      echo "The WebDAV URL must not contain spaces, userinfo, queries, or fragments." >&2
      return 1
      ;;
  esac

  authority=${value#https://}
  authority=${authority%%/*}
  case "$authority" in
    *:*)
      host=${authority%:*}
      port=${authority##*:}
      if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] ||
        ((10#$port < 1 || 10#$port > 65535)); then
        echo "The WebDAV URL has an invalid port." >&2
        return 1
      fi
      ;;
    *)
      host=$authority
      ;;
  esac

  if [ "${#host}" -gt 253 ]; then
    echo "The WebDAV URL hostname is too long." >&2
    return 1
  fi
  case "$host" in
    "" | .* | *. | *..* | *[!A-Za-z0-9.-]*)
      echo "The WebDAV URL must contain a valid DNS hostname." >&2
      return 1
      ;;
  esac
  case "$host" in
    *.*) ;;
    *)
      echo "The WebDAV URL must contain a valid DNS hostname." >&2
      return 1
      ;;
  esac

  IFS="." read -r -a labels <<< "$host"
  for label in "${labels[@]}"; do
    if [ "${#label}" -gt 63 ]; then
      echo "The WebDAV URL contains a hostname label that is too long." >&2
      return 1
    fi
    case "$label" in
      -* | *-)
        echo "The WebDAV URL must contain a valid DNS hostname." >&2
        return 1
        ;;
    esac
  done
}
