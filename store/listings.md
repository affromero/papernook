# papernook Safari extension, store listing copy

Ready-to-paste text for the Mac App Store (Safari). Keep the wording truthful:
the extension collects no data and talks only to the server the user
configures plus the PDF pages they visit.

---

## Shared facts

- **Name:** papernook
- **Category:** Education
- **Price:** Free
- **License:** repository license
- **Data collection:** None. No analytics, no telemetry, no accounts on any
  third-party server. The extension only redirects PDF navigations to the
  papernook server the user configures (their own self-hosted instance) and
  stores that server URL in extension storage.
- **Permissions and why each is needed:**
  - `<all_urls>` host access — any website can host a PDF; the redirect rules
    and toolbar button must be able to act on the page the user is reading.
  - `declarativeNetRequestWithHostAccess` — the automatic "PDF → papernook
    /viewer" redirect is a declarativeNetRequest rule, no page content is read.
  - `storage` — persists the user's papernook server URL and the
    auto-intercept toggle.
  - `activeTab` — the toolbar button reads the current tab's URL to open it in
    the papernook reader.
- **Support / homepage URL:** https://github.com/affromero/papernook

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

**Screenshots to take (1280×800 or 2560×1600):**

1. An arXiv PDF open in /viewer with a reference-preview popover visible.
2. The "Add to library" confirmation (inbox) page.
3. The extension options page with the server URL field.
