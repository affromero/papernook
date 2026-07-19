# Public exposure hardening

[← Documentation home](README.md)

Papernook is private-first: Tailscale or LAN access keeps the profile picker
open for a trusted household. A custom domain is a supported opt-in, but it
must sit behind HTTPS and the instance access gate.

## Recommended configuration

Add these values to `.env`:

```dotenv
PUBLIC_EXPOSURE=true
PAPERNOOK_PUBLIC_HOST=papernook.example.com
PAPERNOOK_PASSWORD=<long unique access password>
SESSION_SECRET=<at least 32 random characters>

# Only the TLS proxy should reach the raw containers from the host.
APP_HOST=127.0.0.1
WEBDAV_HOST=127.0.0.1
```

Then:

1. Replace `papernook.example.com` with the app hostname.
2. Generate `SESSION_SECRET` once with `openssl rand -hex 32`.
3. Put Caddy or another TLS proxy in front of the app. Start with
   [`Caddyfile.example`](../Caddyfile.example).
4. Restart with `docker compose up -d`.
5. Open the HTTPS domain in a private browser window. The access-password
   screen must appear before any profile names.

`PAPERNOOK_PUBLIC_HOST` matters when the same server is also used through
Tailscale. Requests for that public hostname are hardened; localhost,
Tailscale IPs, and Tailscale hostnames keep the private household flow. Without
it, every hostname is treated as public.

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

With `PAPERNOOK_PASSWORD` configured, a new public visitor sees one
instance-level access prompt before the profile picker. Profiles do not each
need another password.

The admin can instead open **Settings → Invite a friend** and send the signed
link or QR code. It bypasses the access prompt, expires after seven days, and
opens the picker. The friend still creates a normal member profile.

If `PAPERNOOK_PASSWORD` is omitted, public mode falls back to per-profile
passwords set on first login. That compatibility path is less convenient for
inviting a new reader; the shared instance password is the recommended setup.

## What the flag changes

- Public requests require either the instance access gate or the fallback
  per-profile password flow.
- Failed instance-gate authentication is throttled per IP. The fallback
  profile-password path is throttled per IP and per account. Password
  comparisons are constant-time.
- Sessions remain HMAC-signed HttpOnly cookies for 90 days and rotate at
  login. A stable `SESSION_SECRET` preserves them across container rebuilds.

## Still on you

- **Bind raw ports to loopback.** Use `APP_HOST=127.0.0.1`. If Caddy also
  proxies WebDAV, use `WEBDAV_HOST=127.0.0.1`. Never publish raw port `3000`
  or `8080` to the internet.
- **Terminate TLS at the proxy.** Do not serve the app publicly over plain
  HTTP.
- **Protect WebDAV separately.** Use a strong, unique `WEBDAV_PASS`. Either
  proxy it at `https://dav.<your-domain>` or keep it Tailscale-only, even when
  the app is public.
- **Treat capture tokens as secrets.** They ride in bookmarklet URLs by
  design, are unique per profile, and can be rotated in Settings.
- **Add edge controls when needed.** A Caddy rate-limit plugin or fail2ban can
  protect the authentication endpoints before requests reach the app.

## Final check

- [ ] `https://papernook.example.com` shows the access gate in a fresh browser.
- [ ] `http://<server>:3000` is not reachable from the public internet.
- [ ] WebDAV accepts its own credentials and exposes only paper PDFs.
- [ ] The admin invite link uses the public hostname.
- [ ] `SESSION_SECRET`, `PAPERNOOK_PASSWORD`, and `WEBDAV_PASS` are backed up
      in the secret manager, not committed to Git.
