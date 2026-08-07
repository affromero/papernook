# papernook Safari extension

Redirects PDF navigations to your papernook `/viewer` page (hover reference
previews + one-tap "Add to library") and adds a toolbar button that opens the
current tab in the reader.

Interception uses declarativeNetRequest redirect rules on an explicit
research-host allowlist (see `DEFAULT_HOSTS` in `background.js`) — never
`<all_urls>`; users can grant additional sites one at a time from the
options page (`optional_host_permissions`), and the toolbar button covers
every other site via `activeTab` with no standing access. Rules only match
query-free PDF URLs (arXiv `/pdf/…`, anything ending in `.pdf`): DNR cannot
URL-encode the matched text, so URLs with query strings (e.g.
`openreview.net/pdf?id=…`) go through the toolbar button instead, which
encodes properly. Your papernook host is excluded from the rules to prevent
redirect loops. If Safari's DNR build rejects `regexSubstitution` dynamic
rules, turn "open automatically" off — button-only mode needs no DNR.

## Develop (no Apple developer account needed)

Safari Settings → Developer → check "Allow unsigned extensions" → press
"Add Temporary Extension…" and pick this `extension/` folder. Enable
papernook under Settings → Extensions, grant site access, and set your
server URL in its preferences.

Temporary extensions unload when Safari quits, and their file snapshot goes
stale when git rewrites files underneath — if resources stop resolving,
uninstall and re-add the folder rather than pressing Reload.

The same folder loads unmodified in Chrome via `chrome://extensions` →
"Load unpacked" (the papernook server is the same either way).

## Distribute

`scripts/build-safari.sh` regenerates the wrapper, fills the app-icon set
(App Review rejects empty icon slots), and archives a signed Release build:

```bash
./scripts/build-safari.sh
xcodebuild -exportArchive -archivePath build/papernook.xcarchive \
  -exportOptionsPlist scripts/export-appstore.plist -exportPath build/
```

Upload from Xcode Organizer or with the exported package. Store listing copy
lives in `store/listings.md`, App Review notes in `store/REVIEWERS.md`, and
the extension privacy policy in `PRIVACY.md`.
