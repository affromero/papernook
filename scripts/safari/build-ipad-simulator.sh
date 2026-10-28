#!/bin/bash
# Build a development-only iOS simulator wrapper from the shared extension.
set -euo pipefail
cd "$(dirname "$0")/../.."

xcrun safari-web-extension-converter extension/ \
  --ios-only --bundle-identifier co.afromero.papernook \
  --project-location ./build/safari-ipad --no-open --no-prompt --force

xcodebuild -project build/safari-ipad/papernook/papernook.xcodeproj \
  -scheme papernook -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/safari-ipad-derived \
  CODE_SIGNING_ALLOWED=NO build

echo "Simulator app: build/safari-ipad-derived/Build/Products/Debug-iphonesimulator/papernook.app"
