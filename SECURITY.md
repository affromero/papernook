# Security

papernook is a self-hosted, private-first application. If you find a
vulnerability, open a private security advisory on this repository (or
contact the maintainer directly) rather than a public issue.

## Model

- **Private mode (default)**: reachable only over Tailscale/LAN; the profile
  picker is intentionally open (household trust model).
- **Public mode** (`PUBLIC_EXPOSURE=true`): every profile must set a
  password (argon2id), with per-IP and per-account exponential lockout and
  constant-time comparisons. See [docs/public-exposure.md](docs/public-exposure.md).
- Sessions: HMAC-SHA256-signed HttpOnly cookies; secret from
  `SESSION_SECRET` or generated once into `data/session-secret` (0600).
- Capture tokens: 48-hex per-profile, timing-safe comparison, rotatable.
- Path safety: every user-influenced path segment passes `assertSlug`;
  chat ids and usernames are format-validated before touching the
  filesystem.
- WebDAV: separate basic-auth credentials; serves the PDF tree only —
  chats, crops, and canvases are never exposed.
- Supply chain: CodeQL, gitleaks, and Dependabot (7-day cooldown) run on
  every push; pre-commit blocks private keys and env files.
