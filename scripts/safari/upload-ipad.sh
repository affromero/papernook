#!/bin/bash
# Upload a signed iOS archive to App Store Connect. This does not submit review.
set -euo pipefail
cd "$(dirname "$0")/../.."

KEY_ID="${ASC_API_KEY_ID:-HKD4KW9CHB}"
ISSUER_ID="${ASC_ISSUER_ID:-bc437eea-9a23-4fec-8a05-e85495c989ad}"
KEY_PATH="${ASC_API_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$KEY_ID.p8}"

test -d build/papernook-ipad.xcarchive || {
  echo "no iOS archive; run bash scripts/safari/build-ipad.sh first" >&2
  exit 1
}
test -f "$KEY_PATH" || {
  echo "no App Store Connect API key at $KEY_PATH" >&2
  exit 1
}

xcodebuild -exportArchive \
  -archivePath build/papernook-ipad.xcarchive \
  -exportOptionsPlist scripts/safari/export-ipad-appstore.plist \
  -exportPath build/ipad-upload \
  -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$KEY_ID" \
  -authenticationKeyIssuerID "$ISSUER_ID"

echo "Uploaded iOS archive to App Store Connect; submit it for review separately."
