# Public exposure hardening

[← Documentation home](README.md)

Papernook is private-first. A custom domain is a supported opt-in, but it must
sit behind HTTPS and two authentication boundaries: the instance access gate
and a per-profile password.

## Recommended configuration

Add these values to `.env`:

```dotenv
PUBLIC_EXPOSURE=true
PAPERNOOK_PUBLIC_HOST=papernook.example.com
PAPERNOOK_WEBDAV_URL=https://dav-papernook.example.com
PAPERNOOK_PASSWORD=<long unique access password>
SESSION_SECRET=<at least 32 random characters>

# Only the TLS proxy should reach the raw containers from the host.
APP_HOST=127.0.0.1
WEBDAV_HOST=127.0.0.1
```

Then:

1. Replace `papernook.example.com` with the app hostname.
2. Replace `dav-papernook.example.com` with the WebDAV hostname routed to the
   sidecar. This explicit value prevents Papernook from guessing a hostname.
3. Generate `SESSION_SECRET` once with `openssl rand -hex 32`.
4. Put Caddy or another TLS proxy in front of the app. Start with
   [`Caddyfile.example`](../Caddyfile.example).
5. Restart with `docker compose up -d`.
6. Open the HTTPS domain in a private browser window. The access-password
   screen must appear before any profile names.

`PUBLIC_EXPOSURE=true` hardens every hostname. Papernook does not trust the
request Host header to select a passwordless mode. Run a separate private-only
instance if a household deployment must remain passwordless.

## Keep private Tailscale access

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

The server admin creates the outer instance password by setting
`PAPERNOOK_PASSWORD`. A new public visitor sees that prompt before any profile
names. After passing it, each reader must enter their own profile password.
New profiles require at least 12 characters. Signed invite links do not bypass
the public gate.

Before enabling public exposure on an existing private installation, sign in
through the private deployment and create a password under **Settings → My
profile** for every profile. A legacy profile without a password deliberately
cannot sign in on the public deployment.

If `PAPERNOOK_PASSWORD` is omitted, public mode fails closed with an admin
setup message. Set it in `.env` (or inject it through your secret manager) and
restart before sharing the public address.

## What the flag changes

- Public requests on every hostname require the instance access gate, and
  profile sessions require a separate scrypt-verified profile password.
- Failed instance-gate authentication is throttled per IP. Direct API login is
  throttled per IP and selected account. Password comparisons are
  constant-time.
- Public sessions remain HMAC-signed Secure, HttpOnly cookies for up to seven
  days and rotate at
  login. They are bound to the current on-disk profile epoch, so deletion
  immediately revokes that profile on every device. A stable `SESSION_SECRET`
  preserves sessions across container rebuilds.

## Still on you

- **Bind raw ports to loopback.** Use `APP_HOST=127.0.0.1`. If Caddy also
  proxies WebDAV, use `WEBDAV_HOST=127.0.0.1`. Never publish raw port `3000`
  or `8080` to the internet.
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

## Final check

- [ ] `https://papernook.example.com` shows the access gate in a fresh browser.
- [ ] `http://<server>:3000` is not reachable from the public internet.
- [ ] WebDAV accepts its own credentials and exposes only paper PDFs.
- [ ] Every profile can sign in only with its own profile password.
- [ ] `SESSION_SECRET`, `PAPERNOOK_PASSWORD`, profile passwords, and
      `WEBDAV_PASS` are backed up in a secret manager, never committed to Git.
