# Notes for App Store reviewers

papernook is a self-hosted paper library; this extension is its Safari
companion. It requires a papernook server, which reviewers will not have, so
provide one of the following in the App Review notes before submitting:

1. **Demo server (recommended):** a temporary papernook instance reachable
   over HTTPS with a demo profile, e.g. `https://demo.papernook.example` plus
   profile name and password. Spin one up with `scripts/install.sh` on any
   host; choose AI provider option 9 (none) — the extension flow needs no AI.
2. **Video fallback:** a short screen recording of the full flow (PDF →
   redirect → hover previews → Add to library) attached to the review notes.

Review-notes text to paste:

> The extension requires the user's own papernook server (self-hosted, open
> source: https://github.com/affromero/papernook). For review, use:
> Server URL: <demo server URL> — set it in the extension's preferences.
> Demo profile: <name> / <password>.
> Test: open https://arxiv.org/pdf/1706.03762 — Safari redirects into the
> papernook reader; hover a bracketed citation like [4] to see the reference
> preview; press "+ Add to library" and confirm to file the paper.

Permissions justification (mirrors store/listings.md): host access is a
fixed allowlist of research sites (arXiv, OpenReview, bioRxiv, medRxiv, ACL
Anthology, NeurIPS, PMLR, CVF) where DNR rewrites PDF navigations to the
user's own server; users may grant additional sites individually via
optional host permissions; `storage` holds the server URL and site list;
`activeTab` lets the toolbar button read the current tab's URL on click.
No page content is read or transmitted.
