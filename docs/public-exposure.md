# Public exposure hardening

papernook is private-first: the intended reach is Tailscale or your LAN, where
the profile picker is deliberately open (household model). Exposing it to the
internet is a supported, deliberate opt-in with real teeth.

## Enable

1. Set `PUBLIC_EXPOSURE=true` in `.env` and restart the stack.
2. Put Caddy (or any TLS proxy) in front — see `Caddyfile.example`.

## What the flag changes

- **Every profile must have a password.** Passwordless profiles are forced to
  set one (min 8 chars) on their next login; verification uses argon2id.
- **Login throttling**: per-IP _and_ per-account failure counters with
  exponential lockout (2s → 15min) and constant-time comparisons. State is
  in-memory — a restart clears it, which only helps the legitimate owner.
- Sessions remain HMAC-signed HttpOnly cookies (90 days, rotated each login);
  set `SESSION_SECRET` in `.env` so container rebuilds keep sessions valid.

## Still on you

- **TLS**: terminate HTTPS at Caddy; never expose port 3000 raw.
- **WebDAV**: give it its own subdomain + strong `WEBDAV_PASS`, or better,
  keep WebDAV Tailscale-only even when the app is public — the iPad is on
  your tailnet anyway.
- **Capture tokens** ride in URLs by design (bookmarklet). They are
  per-profile, 48 hex chars, rotatable in Settings — rotate if one leaks.
- **Edge rate limiting**: add Caddy's rate-limit plugin or fail2ban on the
  auth endpoints if you see bot pressure; the app's lockout is the second
  layer, not the only one.
