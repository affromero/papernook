# papernook browser extension, store listing copy

Ready-to-paste text for the Chrome Web Store and Mac App Store (Safari). Keep
the wording truthful: the developer collects no data, and the extension sends
page URLs only to the self-hosted server the user configures.

---

## Shared facts

- **Chrome name:** papernook
- **Mac name:** Papernook for Safari ("Papernook" alone is taken on the App
  Store; the binary and extension still display as "papernook")
- **Mac App Store listing (live since 2026-08-18):**
  https://apps.apple.com/app/id6799779482 — Apple ID 6799779482, version
  0.1.0 (build 162). Use as the "also available for Safari" link in the
  Chrome listing.
- **Mac category:** Education
- **Price:** Free
- **Copyright:** © 2026 Andrés Romero
- **License:** MIT (see repository LICENSE)
- **Privacy policy URL:** https://github.com/affromero/papernook/blob/main/PRIVACY.md
- **Mac App Privacy questionnaire:** answer "Data Not Collected" — the
  developer receives no extension data.
- **Age rating:** 4+ (no objectionable content).
- **Developer data collection:** None. No analytics, no telemetry, no accounts
  on any third-party server. The extension handles page URLs only to redirect
  PDF navigations to the papernook server the user configures (their own
  self-hosted instance) and stores that server URL in extension storage.
- **Permissions and why each is needed:**
  - Host access is an explicit research-site allowlist (arxiv.org,
    openreview.net, biorxiv.org, medrxiv.org, aclanthology.org,
    proceedings.neurips.cc, proceedings.mlr.press, openaccess.thecvf.com) —
    the automatic PDF redirect only acts there. Users can extend it one site
    at a time (`optional_host_permissions`, granted explicitly per site).
  - `declarativeNetRequestWithHostAccess` — the automatic "PDF → papernook
    /viewer" redirect is a declarativeNetRequest rule, no page content is read.
  - `storage` — persists the user's papernook server URL, the auto-intercept
    toggle, and user-added sites.
  - `activeTab` — the toolbar button reads the current tab's URL on click to
    open it in the papernook reader; no standing access to other sites.
- **Support / homepage URL:** https://github.com/affromero/papernook

## Chrome Web Store

**Item:** `cglnjlhkdgahafajfimnaonnlapecpfh` (assigned by Google on first
upload; this is `EXTENSION_ID` for `npm run release:chrome`). Reach the item
from the Developer Dashboard — the dashboard URL embeds the private publisher
account id, so it is deliberately not recorded here.

**Language:** English (United States).

**Summary (132 characters max):**

> Open research PDFs in your self-hosted papernook reader for citation previews, annotation, capture, and AI-assisted reading.

**Description:**

papernook connects the papers you browse to the research library you run.

- Open supported arXiv and direct PDF links automatically in the papernook
  reader.
- Send any other HTTP or HTTPS page from the toolbar with one click.
- Preview cited references, annotate the PDF, capture it into your library, and
  continue reading beside a paper-grounded AI chat.
- Add research sites individually when you want automatic PDF opening beyond
  the built-in allowlist.

The extension requires your own papernook server. It has no hosted service,
analytics, advertising, or developer-operated data collection. The current
page URL is sent only when needed to the server URL you configure.

Also available for Safari on the Mac App Store:
https://apps.apple.com/app/id6799779482

papernook is open source under the MIT License.

**Single purpose (Privacy practices):**

> Open research-paper pages and PDFs in the user's self-hosted papernook reader.

**Permission justifications (Privacy practices):**

- `declarativeNetRequestWithHostAccess`: redirects matching PDF navigations on
  the declared research-site allowlist into the configured papernook reader;
  extension code does not inspect the response body.
- Built-in host access: limits automatic opening to the research sites named in
  Shared facts above.
- Optional host access: lets a user opt in one additional research domain at a
  time from extension options.
- `storage`: saves the configured papernook URL, automatic-opening preference,
  and user-added domains.
- `activeTab`: reads the current tab URL only after the user presses the toolbar
  button, then opens that URL through the user's own papernook server.

**Remote code:** No — the extension executes no remotely hosted code. Every
runtime file ships inside the package (`scripts/extension/build-chrome.mjs`
verifies each manifest-referenced file exists before zipping).

**Data types collected:** tick **Website content** only (the current page
URL). Leave every other category — personally identifiable information,
health, financial, authentication, personal communications, location, user
activity — unticked.

**Certifications:** all three apply — the data is not sold to third parties,
is not used or transferred for purposes unrelated to the item's single
purpose, and is not used or transferred to determine creditworthiness or for
lending purposes.

**User-data disclosure:** The extension handles web-browsing activity in the
form of the current page URL. Automatic rules pass a matching PDF URL to the
configured server; the toolbar does so only on click. The developer does not
receive, retain, sell, or use this information, and no page content, cookies,
or authentication data are read. Link the dashboard to `PRIVACY.md` and certify
Limited Use.

**Category:** Productivity

**Distribution:** free, all regions, visibility Public. Expect Google's slower
manual review: the eight-domain research allowlist means a human reads the
permission justifications above.

**Required assets:**

- Store icon: `extension/icons/icon-128.png` (128×128 PNG).
- Screenshots: upload one to five full-bleed 1280×800 images from
  `build/screenshots/`; regenerate them with
  `node scripts/store/screenshots.mjs`.
- Small promo tile: `build/screenshots/promo-tile-440x280.png`, generated by
  `node scripts/store/promo-tile.mjs` (the app mark on the same warm paper
  gradient as the macOS app icon).
- Optional marquee tile: 1400×560 PNG or JPEG. Not generated; only needed if
  the listing is ever featured.
- Optional YouTube video: upload the output of
  `node scripts/store/demo-video.mjs`.

**First submission:**

```bash
npm run test:chrome
# Upload build/papernook-chrome.zip as a new item in the Chrome Developer Dashboard.
```

Complete Store Listing, Privacy practices, Distribution, and Test instructions
using this file and `store/REVIEWERS.md`. The first submission is manual. Once
Google assigns an item ID and OAuth credentials are exported as documented in
`.env.example`, later versions can be published with:

```bash
npm run release:chrome
```

Increment `package.json`, `package-lock.json`, and `extension/manifest.json`
together before uploading a version that the store has not seen.

## Mac App Store

**Subtitle (30 chars max):** Read PDFs in your papernook

**Promotional text:**
Send any paper you're reading straight into your self-hosted papernook
library — hover citations to preview references, annotate on iPad, chat with
your own AI.

**Description:**
papernook for Safari opens the PDFs you browse in your papernook reader.

- Automatic: arXiv and direct PDF links redirect into your reader, with hover
  previews for reference citations.
- One tap: the toolbar button sends any page to papernook.
- Capture: add the paper to your self-hosted library and keep reading with
  annotations, canvases, and per-paper AI chats.

Requires a papernook server (self-hosted, open source — see the homepage).
The extension sends nothing anywhere except the server you configure.

**Keywords:** papers,pdf,arxiv,research,reader,library,annotate,citations

**Screenshots (2560×1600):** generated by `scripts/store/screenshots.mjs`
into `build/screenshots/` — viewer with a reference-preview popover, the
library, and a paper with the reader + chat. The App Review demo video comes
from `scripts/store/demo-video.mjs` (`build/demo/extension-demo.mp4`).
