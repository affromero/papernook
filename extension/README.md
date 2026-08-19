# papernook browser extension

The same Manifest V3 extension runs in Chrome and Safari. It redirects supported
PDF navigations to your papernook `/viewer` page and adds a toolbar button that
opens any HTTP(S) tab in the reader.

Interception uses declarativeNetRequest redirect rules on an explicit
research-host allowlist (see `DEFAULT_HOSTS` in `background.js`), never
`<all_urls>`. Users can grant additional sites one at a time from the options
page. The toolbar button covers every other site through `activeTab`, with no
standing access.

Rules only match query-free PDF URLs (arXiv `/pdf/…`, or a URL ending in
`.pdf`). DNR cannot URL-encode matched text, so URLs with query strings, such as
`openreview.net/pdf?id=…`, use the toolbar button instead. The configured
papernook host is excluded to prevent redirect loops.

## Chrome

Install [**papernook**](https://chromewebstore.google.com/detail/cglnjlhkdgahafajfimnaonnlapecpfh) from the Chrome Web Store, then open the
extension's **Details → Extension options** and enter your papernook server
URL.

To run a build the store does not have yet, load it unpacked:

1. Download and unzip the repository source. If a GitHub release includes
   `papernook-chrome.zip`, that smaller package works too.
2. Open `chrome://extensions`, enable **Developer mode**, and select
   **Load unpacked**.
3. Choose `extension/`, or the unzipped package directory containing
   `manifest.json`.
4. Open the extension's **Details → Extension options** and enter your
   papernook server URL.

For development, run `npm run build:chrome` and load `build/chrome`. Verify the
real packaged extension with `npm run test:chrome` after installing Playwright's
Chromium (`npx playwright install chromium`).

### Releasing a new version

`npm run release:chrome` builds the zip and uploads it as a draft; the item
stays on its published version until `npm run release:chrome:publish` submits
the draft. (The upstream CLI publishes when given no subcommand — both scripts
name theirs explicitly so an upload can never go live by itself.) The manifest
version must be higher than the published one.

The first submission was manual. Every upload after it authenticates with an
OAuth refresh token through five environment variables: `EXTENSION_ID` (public,
in `.env.example`), `PUBLISHER_ID`, `CLIENT_ID`, `CLIENT_SECRET`, and
`REFRESH_TOKEN`. They live in Infisical, so a release reads them at run time:

```bash
infisical run --projectId d95f3446-3d13-477f-aa23-12d431759f09 \
  --env prod --path /chrome -- npm run release:chrome
```

#### Minting the credentials (once)

The Chrome Web Store API authenticates as _you_, so these steps need the
publisher Google account in a browser:

1. In [Google Cloud console](https://console.cloud.google.com), pick or create
   a project, then enable the
   [Chrome Web Store API](https://console.cloud.google.com/apis/library/chromewebstore.googleapis.com).
2. Open **Google Auth Platform** (what used to be the OAuth consent screen) and
   press **Get started**: app name, the publisher account as support and
   contact email, audience **External**.
3. **Data access → Add or remove scopes**: the Chrome Web Store scope is not in
   the picker, so paste `https://www.googleapis.com/auth/chromewebstore` into
   the manual box and save.
4. **Audience → Publish app.** A consent screen left in Testing expires every
   refresh token it issues after seven days; this scope needs no verification
   for a personal publisher account.
5. **Clients → Create client**, application type **Desktop app**. Keep the
   client ID and secret.
6. Run `npx chrome-webstore-upload-keys`, paste that client ID and secret, and
   approve in the browser — it prints the refresh token. (By hand: request the
   scope above with a loopback redirect, then exchange the code at
   `https://oauth2.googleapis.com/token` with `access_type=offline`.)
7. Take the **Publisher ID** from the Developer Dashboard's **Publisher →
   Settings** page (it is also the path segment after `/devconsole/` in the
   dashboard URL). Every v2 API path embeds it, and no API returns it — the
   aliases `me` and `-` both 404.
8. Store the four values in Infisical, in the `papernook` project under
   `/chrome` in `prod` — the same shape as `/apple`, which holds the App Store
   Connect key for the Safari upload:

   ```bash
   infisical secrets set --projectId d95f3446-3d13-477f-aa23-12d431759f09 \
     --env prod --path /chrome \
     PUBLISHER_ID=... CLIENT_ID=... CLIENT_SECRET=... REFRESH_TOKEN=... \
     EXTENSION_ID=...
   ```

If a release fails with `invalid_grant`, the refresh token was revoked — redo
the last step. The usual cause is a consent screen that slipped back to
Testing.

## Safari

Install [**Papernook for Safari**](https://apps.apple.com/app/id6799779482)
from the Mac App Store (free), then enable it under Safari Settings →
Extensions, grant site access, and set your papernook server URL in its
preferences.

For development, open Safari Settings → Developer, enable **Allow unsigned
extensions**, select **Add Temporary Extension…**, and choose this `extension/`
folder. Enable papernook under Settings → Extensions, grant site access, and set
the server URL in its preferences.

Temporary extensions unload when Safari quits, and their file snapshot can go
stale when git rewrites files. If resources stop resolving, uninstall and re-add
the folder instead of pressing Reload. If a Safari DNR build rejects dynamic
`regexSubstitution` rules, turn automatic opening off and use button-only mode.

`scripts/safari/build.sh` regenerates the native wrapper, fills the required app
icon slots, and archives a signed Release build; `scripts/safari/upload.sh`
exports that archive straight to App Store Connect. `npm run release:safari`
runs both.

## Store assets and review

Listing copy lives in `store/listings.md`, reviewer instructions in
`store/REVIEWERS.md`, and the shared extension privacy policy in `PRIVACY.md`.
Screenshots and the review demo video are generated by
`scripts/store/screenshots.mjs` and `scripts/store/demo-video.mjs`.
