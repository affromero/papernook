# Security

papernook is a self-hosted, private-first application. If you find a
vulnerability, open a private security advisory on this repository (or
contact the maintainer directly) rather than a public issue.

## Model

- **Private mode (default)**: reachable only over Tailscale/LAN; the profile
  picker is intentionally open (household trust model).
- **Public mode** (`PUBLIC_EXPOSURE=true`): `PAPERNOOK_PASSWORD` places an
  instance gate before the profile picker, then each reader proves a separate
  scrypt-hashed profile password. The server fails closed when the instance
  password, session secret, or profile credential is missing. Authentication
  is throttled per IP and account with exponential backoff. See
  [docs/public-exposure.md](docs/public-exposure.md).
- Public deployments must bind raw app and WebDAV ports to loopback so only
  the TLS proxy is internet-facing. Public mode gates every Host value; headers
  cannot select a passwordless route.
- Sessions: HMAC-SHA256-signed Secure, HttpOnly, SameSite cookies. Public
  sessions expire after seven days and require a stable `SESSION_SECRET`.
- Capture tokens: 48-hex per-profile, timing-safe comparison, rotatable, and
  submitted in POST bodies rather than URLs.
- Profile deletion removes that reader's profile, capture credentials, Zotero
  connection, chats, pasted crops, pending captures, rate-limit state, and
  owned share links. Confirmed papers remain shared with erased attribution.
- Path safety: every user-influenced path segment passes `assertSlug`;
  chat ids and usernames are format-validated before touching the
  filesystem.
- WebDAV: separate basic-auth credentials; serves the PDF tree only.
  Chats, crops, and canvases are never exposed.
- Agent boundary: tool-capable Claude Code and Codex CLI providers are refused
  in public mode. API and local model endpoints receive prompts without host
  filesystem tools.
- Supply chain: CodeQL, gitleaks, and Dependabot (7-day cooldown) run on
  every push; pre-commit blocks private keys and env files.
