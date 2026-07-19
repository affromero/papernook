# Security

papernook is a self-hosted, private-first application. If you find a
vulnerability, open a private security advisory on this repository (or
contact the maintainer directly) rather than a public issue.

## Model

- **Private mode (default)**: reachable only over Tailscale/LAN; the profile
  picker is intentionally open (household trust model).
- **Public mode** (`PUBLIC_EXPOSURE=true`): the recommended
  `PAPERNOOK_PASSWORD` places one access gate before the profile picker. The
  server fails closed when the admin has not configured that password; readers
  never create or manage profile passwords. The instance gate locks out failed
  attempts per IP, and password comparisons are constant-time. See
  [docs/public-exposure.md](docs/public-exposure.md).
- Public deployments must bind raw app and WebDAV ports to loopback so only
  the TLS proxy is internet-facing. `PAPERNOOK_PUBLIC_HOST` lets the same
  instance distinguish a hardened public domain from private Tailscale access.
- Sessions: HMAC-SHA256-signed HttpOnly cookies; secret from
  `SESSION_SECRET` or generated once into `data/session-secret` (0600).
- Capture tokens: 48-hex per-profile, timing-safe comparison, rotatable.
- Profile deletion removes that reader's profile, capture credentials, Zotero
  connection, chats, pasted crops, pending captures, rate-limit state, and
  owned share links. Confirmed papers remain shared with erased attribution.
- Path safety: every user-influenced path segment passes `assertSlug`;
  chat ids and usernames are format-validated before touching the
  filesystem.
- WebDAV: separate basic-auth credentials; serves the PDF tree only.
  Chats, crops, and canvases are never exposed.
- Supply chain: CodeQL, gitleaks, and Dependabot (7-day cooldown) run on
  every push; pre-commit blocks private keys and env files.
