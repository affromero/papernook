# Changelog

All notable changes to Papernook are documented in this file.

## [0.2.0] - 2026-08-18

The reader learns to follow citations, conversations become durable and
verifiable, capture stops blocking on slow downloads, and the browser extension
reaches the Mac App Store and the Chrome Web Store.

### Added

#### Browser extension

- Safari and Chrome extension that redirects PDFs from research hosts — arXiv,
  OpenReview, bioRxiv, medRxiv, ACL Anthology, NeurIPS, PMLR, and CVF — into
  the reader, with a toolbar button everywhere else that needs no site access
  until clicked, and per-site opt-in for additional hosts.
- The options page tests the connection when the server URL is saved and
  reports permission, reachability, and redirect-rule failures separately.
- Distribution pipeline for both stores: packaging, listing copy, reviewer
  instructions, generated screenshots, a review demo video, and a promo tile.

#### Reading and annotation

- Citation following: inline citations are detected in page text, the
  bibliography is indexed and matched to entries, and in-paper references
  resolve through their hyperref destinations, with a caption text-search
  fallback for papers that lack them.
- Reference previews work on papers without embedded citation links, and
  previewing is separated from editing so a hover no longer risks an edit.
- Annotations can be edited after saving, remote saves are picked up silently
  instead of demanding a reload, and truncated saves are rejected rather than
  written.
- Trackpad pinch zoom on desktop, and a draggable divider to resize the chat
  panel against the page.

#### Conversations

- Assistant messages render as markdown with KaTeX math and highlighted code.
- Conversations can be deleted whole or message by message, are named from the
  first query, keep their selection across a refresh, and offer sent-message
  history controls.
- Answers cite verified source links, render linked source excerpts, and drive
  the PDF pane when a paper reference or citation is clicked.
- Three.js blocks run in a sandboxed viewer with an inline runtime, readable
  overlays, reported failures, and in-context regeneration.
- Providers gain web access, vision-gated image attachments, live streaming
  deltas from the `claude-code` CLI, Codex model and effort discovery, and full
  paper text for CLI providers, with web-capable providers fetching the source
  when the extracted text is truncated.

#### Capture and library

- Capture is asynchronous end to end: `/add` returns a polling pending page,
  on-disk job markers survive renames, the inbox shows job cards, and the
  viewer captures inline with a spinner instead of navigating away.
- Inbox cards can be deleted, the review page offers existing topics as
  tappable chips, and papers link back to their original source.
- Every capture failure is logged, with dead-connection errors explained
  rather than surfaced raw.

#### Settings

- Model discovery results and profile avatar editing, with a clearer section
  hierarchy and simpler transitions.

### Changed

- The instance password is the only credential; per-profile passwords are gone
  and the sudo prompt asks once per page load.
- CLI AI providers reload their credentials from Settings without a restart.
- Tabs are titled by paper name.

### Fixed

- Mode toggles no longer phantom-save the document, and save versions compare
  weak-insensitively so annotations survive proxies that rewrite ETags.
- Long-running streams stay alive instead of timing out mid-answer.

### Security

- CLI providers spawn with an allowlisted environment and a pinned container
  credential path, and `OPENAI_API_KEY` no longer reaches Settings endpoints.
- Paper text is marked as untrusted source material, agent answers never
  auto-load images, and chat requires verified source links.
- `/add` gets its own lockout bucket, and the sandbox, extraction, and
  proxy-trust holes found in three review passes are closed.
- `html-to-text` is pinned to 9.0.5 to clear the `deepmerge-ts` advisory.

### Deployment notes

- The extension version tracks the repository version; the Chrome package
  refuses to build unless `package.json`, its lock, `extension/manifest.json`,
  and the release tag agree.

## [0.1.0] - 2026-07-20

Papernook v0.1.0 is the first source release of the self-hosted paper library.

### Added

- Filesystem-first paper storage with a rebuildable SQLite search index,
  topic and tag organization, citation exports, related-work discovery, and
  metadata-first Zotero synchronization.
- Browser and iOS capture flows for arXiv, OpenReview, direct PDFs, and
  publisher pages, with an inbox review step before papers reach WebDAV.
- PDF reading and annotation with highlights, text, Apple Pencil ink,
  internal-reference previews, exercises, expandable margins, and atomic
  saves.
- Shared visual canvases with PDF page synchronization, media assets, and
  production tldraw license validation.
- Per-paper AI conversations through configurable Anthropic, OpenAI, local
  OpenAI-compatible, Claude Code, and Codex providers.
- Per-profile private chats, capture tokens, and Zotero connections alongside
  a shared paper library, annotations, and canvases.
- Revocable, view-only paper sharing with optional immutable conversation
  snapshots.
- Docker Compose deployment, optional WebDAV compatibility, backup tooling,
  guided onboarding, and device connection instructions.

### Security

- Public deployments fail closed behind a distinct instance password and
  scrypt-hashed per-profile passwords, with session revocation, bounded request
  bodies, authentication backoff, global request throttling, and strict
  security headers.
- Public mode gates every hostname and shared-reading route, prevents signed
  invites from bypassing the password, and refuses tool-capable CLI AI
  providers.
- The runtime container runs as a non-root user and is assembled from an
  allowlisted standalone artifact that excludes repository source, tests,
  documentation, local environment files, and private data.
- CI pins third-party actions and the base image, scans full Git history for
  secrets, runs CodeQL and dependency auditing, and smoke-tests the hardened
  container.

### Deployment notes

- This release provides source archives; it does not publish a prebuilt
  container image or hosted service.
- Production Canvas requires a suitable tldraw license key.
- Public deployment requires unique values for `PAPERNOOK_PASSWORD`,
  `SESSION_SECRET`, every profile password, and WebDAV credentials when WebDAV
  is enabled.
- WebDAV is optional and separately authenticated. It exposes
  `data/papers` only.
- For a reproducible install, check out the `v0.1.0` tag before running
  `scripts/install.sh`. The one-line installer on `main` follows current
  development.

[0.2.0]: https://github.com/affromero/papernook/releases/tag/v0.2.0
[0.1.0]: https://github.com/affromero/papernook/releases/tag/v0.1.0
