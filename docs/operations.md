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
storage. It contains passwords, API credentials, private chats, and PDFs.

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

- `PUBLIC_EXPOSURE=true` gates every hostname. Host headers cannot select a
  passwordless mode.
- Raw app and WebDAV ports bind to `127.0.0.1`; only the TLS proxy is public.
- `PAPERNOOK_PASSWORD`, every profile password, `WEBDAV_PASS`, and
  `SESSION_SECRET` are distinct and stored outside Git.
- CLI AI providers are refused in public mode. Use a tool-free API or local
  model endpoint.
- Review logs and repeated `429` responses. Put edge rate limiting or fail2ban
  in front of `/api/v1/gate` and `/api/v1/session` for high-traffic hosts.
- Rotate a capture token immediately if its bookmarklet or Shortcut is lost.
