# Operations

[← Documentation home](README.md)

## Backup

Papernook's filesystem is the source of truth. A complete backup includes
`.env` plus `data/users`, `data/library`, and `data/papers`. The SQLite index is
excluded because it is rebuildable.

Run:

```bash
./scripts/backup.sh
```

The script stops the app and WebDAV briefly, writes a mode-`0600` archive under
`backups/`, and restarts both services. Store the archive in encrypted off-host
storage. It contains passwords, API credentials, per-profile chats, and PDFs.

## Restore

1. Stop services with `docker compose down`.
2. Move the existing `.env` and `data/` aside; do not merge trees.
3. Extract the backup from the repository root.
4. Restrict permissions with `chmod 600 .env` and ensure the container user can
   write `data/`.
5. Start with `docker compose up -d`.
6. Confirm `/api/v1/health` returns `{"status":"ok",...}`, sign in, open a
   paper, and verify WebDAV shows only `data/papers`.

Startup recovers an interrupted cross-topic move before rebuilding
`data/index.db`.

## Upgrade and rollback

1. Run a backup and record the current Git tag or commit.
2. Read release notes for authentication or filesystem changes.
3. Check out the intended release tag and run
   `docker compose up -d --build`.
4. Verify container health, sign-in, capture, chat, and WebDAV.

To roll back, stop the stack, check out the recorded prior release, restore the
matching backup, and rebuild. Do not run two versions against the same data
tree.

## Public deployment checks

- Authentication is always on and identical for every hostname.
- `PAPERNOOK_PASSWORD` is set to a long, unique instance access password.
  Docker Compose refuses to start without it, and the login API returns `503`
  when it is unset.
- Raw app and WebDAV ports bind to `127.0.0.1`; only the TLS proxy is public.
- Setting `APP_HOST` or `WEBDAV_HOST` to `0.0.0.0` publishes plaintext HTTP.
  Do this only on a trusted network. WebDAV basic-auth credentials are clear
  on the wire without TLS.
- `PAPERNOOK_PASSWORD` and `WEBDAV_PASS` are distinct and stored outside Git.
  `SESSION_SECRET` is optional; when unset, Papernook generates and preserves
  it in `data/session-secret`.
- `TRUSTED_PROXY_HOPS` matches the number of reverse proxies in front of the
  app. Keep the default `1` for a single Caddy, and set it to `0` when the app
  port is published directly.
- CLI AI providers are allowed. The admin's provider selection in Settings is
  the consent to use Claude Code or Codex.
- Review logs and repeated `429` responses. Put edge rate limiting or fail2ban
  in front of `/api/v1/gate` and `/api/v1/session` for high-traffic hosts.
- Rotate a capture token immediately if its bookmarklet or Shortcut is lost.
