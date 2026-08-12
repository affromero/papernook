# Expose Papernook on a custom domain

[← Documentation home](README.md)

Papernook requires the same instance access gate on every hostname. A custom
domain changes how traffic reaches the server, not how authentication works.
Caddy should terminate TLS before forwarding the app and WebDAV to their
loopback-bound ports.

## Recommended configuration

Add these values to `.env`:

```dotenv
PAPERNOOK_PUBLIC_HOST=papernook.example.com
PAPERNOOK_WEBDAV_URL=https://dav-papernook.example.com
PAPERNOOK_PASSWORD=<long unique access password>

# These are already the defaults. Keep them explicit on an internet host.
APP_HOST=127.0.0.1
WEBDAV_HOST=127.0.0.1

# One Caddy proxy is the default.
TRUSTED_PROXY_HOPS=1

# Optional. When unset, Papernook generates data/session-secret.
# SESSION_SECRET=<at least 32 random characters>
```

Then:

1. Create DNS `A` and, when applicable, `AAAA` records for the app and WebDAV
   hostnames. Point both at the server.
2. Replace `papernook.example.com` with the app hostname in `.env` and
   [`Caddyfile.example`](../Caddyfile.example).
3. Replace `dav-papernook.example.com` with the WebDAV hostname routed to the
   sidecar. Set its HTTPS URL in `PAPERNOOK_WEBDAV_URL`.
4. Put Caddy in front of both loopback services. Start with
   [`Caddyfile.example`](../Caddyfile.example).
5. Restart with `docker compose up -d`.
6. Open the HTTPS domain in a private browser window. The access-password
   screen must appear before any profile names.

`PAPERNOOK_PASSWORD` is required. Docker Compose refuses to start without it,
and the login API returns `503` if it is unset. Authentication remains on for
the custom domain, Tailscale names, LAN addresses, and direct IP requests.

## Keep Tailscale access

Loopback bindings intentionally prevent other machines from opening raw ports
`3000` and `8080`. If this server should also be reachable privately through
Tailscale, publish those loopback services to the tailnet:

```bash
tailscale serve --bg 3000
tailscale serve --bg --tcp=8080 tcp://127.0.0.1:8080
tailscale serve status
```

The first command is also the recommended route for Tailscale-only installs:
production session cookies require HTTPS. It prints an app URL such as
`https://papernook-server.example-tailnet.ts.net`. The second keeps WebDAV
available at
`http://papernook-server.example-tailnet.ts.net:8080`. These routes remain
tailnet-only; do not use Tailscale Funnel.

See the current
[Tailscale Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
if your installed client reports different syntax.

## What visitors see

The server admin sets the only Papernook credential in `PAPERNOOK_PASSWORD`.
A visitor enters it before seeing profile names, then may create or select any
profile without another password. Profiles keep chats, capture tokens, and
Zotero connections organized by person. They are a courtesy boundary between
people who already share the instance password, like viewer profiles on a
streaming service. They are not a security boundary. Anyone with the instance
password can switch profiles and read any profile's chats.

An admin can instead send the signed link from **Settings → Invite a friend**.
Opening `/invite?t=...` opens the gate for seven days without revealing the
instance password. Sessions also last seven days. `SESSION_SECRET` is optional;
Papernook generates it once in `data/session-secret` when it is unset so
sessions survive container rebuilds.

Share links do not require the gate or a profile session. Their unguessable
share id is the capability to read that one shared paper.

## Still on you

- **Keep raw ports on loopback.** `APP_HOST` and `WEBDAV_HOST` both default to
  `127.0.0.1`. Caddy terminates TLS in front of them. Setting either to
  `0.0.0.0` publishes plaintext HTTP, so do it only on a trusted network.
  WebDAV sends its password in clear on a plaintext connection.
- **Terminate TLS at the proxy.** Do not serve the app publicly over plain
  HTTP.
- **Protect WebDAV separately.** Use a strong, unique `WEBDAV_PASS`. Either
  set `PAPERNOOK_WEBDAV_URL` to that HTTPS endpoint, and proxy it separately
  from the app; or keep WebDAV Tailscale-only.
- **Treat capture tokens as secrets.** Bookmarklets POST them in request bodies
  so they do not enter history, proxy logs, or referrers. They remain bearer
  credentials and can be rotated in Settings.
- **Add edge controls when needed.** A Caddy rate-limit plugin or fail2ban can
  protect the authentication endpoints before requests reach the app.
- **Configure proxy trust exactly.** `TRUSTED_PROXY_HOPS` is the number of
  reverse proxies in front of the app. Its default is `1` for a single Caddy.
  Set it to `0` if the app port is published directly so forged
  `X-Forwarded-For` values cannot create fresh rate-limit buckets.
- **Choose agent providers deliberately.** Claude Code and Codex CLI providers
  are allowed. Selecting one in Settings records the admin's consent.

## Final check

- [ ] `https://papernook.example.com` shows the access gate in a fresh browser.
- [ ] `http://<server>:3000` is not reachable from the public internet.
- [ ] WebDAV accepts its own credentials and exposes only paper PDFs.
- [ ] An invite link opens the gate without displaying the instance password.
- [ ] A share link opens its one paper without a login.
- [ ] `TRUSTED_PROXY_HOPS` matches the deployed proxy chain.
- [ ] `PAPERNOOK_PASSWORD` and `WEBDAV_PASS` are backed up in a secret manager
      and never committed to Git.
