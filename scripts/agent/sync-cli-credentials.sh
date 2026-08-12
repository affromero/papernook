#!/usr/bin/env sh

set -eu

sync_root="${PAPERNOOK_SYNC_ROOT:-/credential-sync}"
host_claude="${PAPERNOOK_HOST_CLAUDE_DIR:-/host-claude}"
host_codex="${PAPERNOOK_HOST_CODEX_DIR:-/host-codex}"
requests="$sync_root/requests"
responses="$sync_root/responses"
rm -f "$sync_root/ready"
mkdir -p "$requests" "$responses"
chmod 777 "$requests" "$responses"

copy_or_remove() {
  source_file="$1"
  target_file="$2"
  if [ -f "$source_file" ] && [ -s "$source_file" ]; then
    tmp="${target_file}.$$"
    cp "$source_file" "$tmp"
    # The named volume is private to the app and this networkless sidecar.
    # World-readability lets the unprivileged app process install its copy.
    chmod 644 "$tmp"
    mv -f "$tmp" "$target_file"
  else
    rm -f "$target_file"
  fi
}

sync_credentials() {
  copy_or_remove "$host_claude/.credentials.json" "$sync_root/claude-credentials.json"
  copy_or_remove "$host_codex/auth.json" "$sync_root/codex-auth.json"
}

if [ -d "$host_claude" ]; then
  : > "$sync_root/supports-claude"
else
  rm -f "$sync_root/supports-claude"
fi
if [ -d "$host_codex" ]; then
  : > "$sync_root/supports-codex"
else
  rm -f "$sync_root/supports-codex"
fi
sync_credentials
: > "$sync_root/ready"

while true; do
  found=false
  for request in "$requests"/*; do
    [ -f "$request" ] || continue
    found=true
    nonce="${request##*/}"
    sync_credentials
    : > "$responses/$nonce"
    rm -f "$request"
  done
  [ "$found" = true ] || sleep 1
done
