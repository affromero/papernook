#!/bin/bash
# Export build/papernook.xcarchive and upload it to App Store Connect.
# Split from build.sh, which used to print this command for hand-running.
# Signing is manual (see export-appstore.plist for why) and auth is the ASC
# API key; no -allowProvisioningUpdates, which breaks with this key.
set -euo pipefail
cd "$(dirname "$0")/../.."

KEY_ID="${ASC_API_KEY_ID:-HKD4KW9CHB}"
ISSUER_ID="${ASC_ISSUER_ID:-bc437eea-9a23-4fec-8a05-e85495c989ad}"
KEY_PATH="${ASC_API_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$KEY_ID.p8}"

test -d build/papernook.xcarchive || {
  echo "no build/papernook.xcarchive — run npm run build:safari first" >&2
  exit 1
}
test -f "$KEY_PATH" || {
  echo "no ASC key at $KEY_PATH (backup in Infisical papernook /apple)" >&2
  exit 1
}

xcodebuild -exportArchive \
  -archivePath build/papernook.xcarchive \
  -exportOptionsPlist scripts/safari/export-appstore.plist \
  -exportPath build/upload \
  -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" \
  -authenticationKeyIssuerID "$ISSUER_ID"

echo "uploaded to App Store Connect — submit the build for review in the web UI"
