# Changelog

All notable changes to Papernook are documented in this file.

## [0.1.1] - 2026-08-18

The browser extension reaches both stores, and per-paper conversations gain
history, deletion, and verifiable sources.

### Added

- Browser extension for Safari and Chrome that redirects PDFs from research
  hosts into the reader, with a toolbar fallback everywhere else, per-site
  opt-in for additional hosts, and a connection test when the server URL is
  saved.
- Conversation management: sent-message history controls, deletion of complete
  conversations, automatic naming from the first query, and selection that
  survives a refresh.
- Chat answers link to verified sources, render linked source excerpts, and
  navigate to precise paper references.
- Three.js scenes run in an inline sandbox, report rendering failures, and
  regenerate in context when they fail.
- Original source links on papers, tappable topic chips on the inbox review
  page, and trackpad pinch zoom in the reader on desktop.
- Settings surfaces model results and profile avatar editing.

### Changed

- The instance password is the only credential; per-profile passwords are gone
  and the sudo prompt asks once per page load.
- CLI AI providers reload their credentials from Settings without a restart.

### Security

- CLI providers spawn with an allowlisted environment and a pinned container
  credential path, and `OPENAI_API_KEY` no longer reaches Settings endpoints.
- Paper text is marked as untrusted source material and agent answers never
  auto-load images.
- `/add` gets its own lockout bucket, and the sandbox, extraction, and
  proxy-trust holes found in three review passes are closed.
- `html-to-text` is pinned to 9.0.5 to clear the `deepmerge-ts` advisory.

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

[0.1.1]: https://github.com/affromero/papernook/releases/tag/v0.1.1
[0.1.0]: https://github.com/affromero/papernook/releases/tag/v0.1.0
