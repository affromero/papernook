# Security

papernook is a self-hosted, private-first application. If you find a
vulnerability, open a private security advisory on this repository (or
contact the maintainer directly) rather than a public issue.

## Model

- Authentication is always on and identical for every hostname. Host headers
  cannot select a passwordless route.
- `PAPERNOOK_PASSWORD` is the only Papernook credential. It gates the profile
  picker. Docker Compose refuses to start without it, and the login API returns
  `503` if it is unset. Authentication is throttled per IP and selected account
  with exponential backoff.
- Profiles separate chats, capture tokens, and Zotero connections as a courtesy
  between people who already share the instance password. They are not a
  security boundary. Anyone with the instance password can switch profiles and
  read any profile's chats.
- Invite links are signed capabilities that open the gate for seven days
  without revealing the instance password.
- Share links require no login. The unguessable share id is the capability to
  read that one shared paper.
- Sessions use HMAC-SHA256-signed Secure, HttpOnly, SameSite cookies and expire
  after seven days. `SESSION_SECRET` is optional. When unset, Papernook
  generates and preserves it in `data/session-secret`.
- App and WebDAV ports bind to `127.0.0.1` by default so Caddy can terminate
  TLS in front of both. Setting `APP_HOST` or `WEBDAV_HOST` to `0.0.0.0`
  publishes plaintext HTTP and is safe only on a trusted network. A plaintext
  WebDAV connection exposes its password on the wire.
- `TRUSTED_PROXY_HOPS` is the number of reverse proxies in front of the app.
  It defaults to `1` for a single Caddy. Set it to `0` when the app port is
  published directly so forged `X-Forwarded-For` headers cannot create fresh
  rate-limit buckets. See [docs/public-exposure.md](docs/public-exposure.md).
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
- Agent boundary: Claude Code and Codex CLI providers are allowed when the
  admin selects them in Settings. That choice is the admin's consent to their
  tool-capable execution. API and local model endpoints receive prompts without
  host filesystem tools.
- Supply chain: CodeQL, gitleaks, and Dependabot (7-day cooldown) run on
  every push; pre-commit blocks private keys and env files.
