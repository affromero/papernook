# papernook Safari extension

Redirects PDF navigations to your papernook `/viewer` page (hover reference
previews + one-tap "Add to library") and adds a toolbar button that opens the
current tab in the reader.

Interception uses declarativeNetRequest redirect rules and only matches
query-free PDF URLs (arXiv `/pdf/…`, anything ending in `.pdf`): DNR cannot
URL-encode the matched text, so URLs with query strings (e.g.
`openreview.net/pdf?id=…`) go through the toolbar button instead, which
encodes properly. Your papernook host is excluded from the rules to prevent
redirect loops. If Safari's DNR build rejects `regexSubstitution` dynamic
rules, turn "open automatically" off — button-only mode needs no DNR.

## Develop (no Apple developer account needed)

```bash
xcrun safari-web-extension-converter extension/ --macos-only \
  --project-location extension/xcode
open extension/xcode/papernook/papernook.xcodeproj   # build & run once
```

Then in Safari: Settings → Developer → Allow unsigned extensions, enable
"papernook" under Settings → Extensions, open the extension's settings and
set your server URL. The `extension/xcode/` wrapper is generated and
gitignored — rerun the converter after changing these files, or use
"Reload extension" in Safari's Develop menu.

The same folder loads unmodified in Chrome via `chrome://extensions` →
"Load unpacked" (the papernook server is the same either way).

## Distribute

Signing and App Store / notarized distribution require an Apple Developer
membership ($99/year). Until then, unsigned local installs work per-machine.
