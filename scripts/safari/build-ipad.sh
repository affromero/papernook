#!/bin/bash
# Generate and archive the iOS Safari wrapper. This does not upload the app.
set -euo pipefail
cd "$(dirname "$0")/../.."

TEAM_ID=2HVQQ4W769
VERSION="$(node -p "require('./extension/manifest.json').version")"
BUILD="$(git rev-list --count HEAD)"

xcrun safari-web-extension-converter extension/ \
  --ios-only --bundle-identifier co.afromero.papernook \
  --project-location ./build/safari-ipad --no-open --no-prompt --force

ICONSET="$(find build/safari-ipad -type d -name AppIcon.appiconset | head -1)"
node scripts/safari/appicon.mjs "$ICONSET" ios
node scripts/safari/configure-ipad-project.mjs \
  build/safari-ipad/papernook/papernook.xcodeproj/project.pbxproj

xcodebuild -project build/safari-ipad/papernook/papernook.xcodeproj \
  -scheme papernook -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build/papernook-ipad.xcarchive \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_IDENTITY='Apple Distribution' \
  INFOPLIST_KEY_ITSAppUsesNonExemptEncryption=NO \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" archive

echo "iOS archive: build/papernook-ipad.xcarchive (version $VERSION, build $BUILD)"
