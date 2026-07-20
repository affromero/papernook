# Changelog

All notable changes to Papernook are documented in this file.

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

[0.1.0]: https://github.com/affromero/papernook/releases/tag/v0.1.0
