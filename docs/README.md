# Papernook documentation

Everything you need to go from an empty server to a shared, Pencil-ready paper
library.

> **New here?** Open Papernook, create the first profile, and follow the
> one-screen welcome flow. Then use the guide for the way you reach your
> server.

## Choose how you connect

| I have a custom domain                                                                                                  | I use Tailscale                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Best when friends should open Papernook from any browser. HTTPS and an instance access password protect the public app. | Best when the library should stay off the public internet. Each device runs Tailscale before it can reach Papernook. |
| App: `https://papernook.example.com`                                                                                    | App: `https://papernook-server.<tailnet>.ts.net`                                                                     |
| WebDAV: `https://dav-papernook.example.com`                                                                             | WebDAV: `http://papernook-server:8080`                                                                               |
| [Harden a public domain →](public-exposure.md)                                                                          | [Invite over Tailscale →](user-guide.md#option-b-tailscale)                                                          |

On a public domain, the admin sets an instance password and each reader creates
a separate profile password. Both are required: the outer password hides the
server and profile list, while the profile password protects that reader's
chats, tokens, and integrations.

![Public access gate shown before profile names](images/setup/access-gate.png)

Tailscale Serve supplies the HTTPS address the app needs for secure sessions.
When `PUBLIC_EXPOSURE=true`, every hostname is gated. This fail-closed behavior
prevents a spoofed Host header or accidentally exposed raw port from selecting
a passwordless route.

## Start here

1. **Open your library:** create or choose a profile.
2. **Add a paper:** paste a link into the library, install the
   [Safari/iOS Shortcut](shortcut.md), or use the
   [Chrome extension](../extension/README.md#chrome).
3. **Write on the PDF:** open the paper in Papernook on desktop or iPad; see
   the [iPad guide](ipad-annotation.md).
4. **Bring in another reader:** follow the
   [domain or Tailscale invite flow](user-guide.md#invite-a-friend).

For backup, restore, upgrades, rollback, and deployment checks, see
[Operations](operations.md).

![Papernook library with topics, search, tags, and paper cards](images/product/library.png)

## What to expect

### One library, separate readers

![Profile picker with two readers and an Add profile action](images/setup/profile-picker.png)

Each person chooses a profile. Papers, folders, tags, annotations, and exercises
are shared. Chats, capture tokens, and Zotero connections remain
per-profile.

### A setup screen that fills itself in

![Welcome screen with chat, capture, and reader setup](images/setup/welcome.png)

The welcome flow reads the server configuration and presents the exact links
and credentials that person needs. Secrets stay masked until copied.

### A direct handoff to another device

![Connect a device card with reach guidance, QR code, and install steps](images/setup/connect-device.png)

Open **Settings → Connect a device** from the address you want the new device
to use. The QR code preserves that domain, Tailscale hostname, or LAN address.

### The paper and its conversations together

![Paper reader beside a grounded conversation](images/product/paper-and-chat.png)

Read and annotate the live PDF, resume prior chats, save exercises, or create a
view-only reading from one screen. **Focus reading** hides chat on desktop and
expands the PDF; the preference persists until **Show chat** is selected.

![Web reader with annotation tools and chat](product-preview.png)

![Full-width paper view with chat hidden](images/product/paper-focus.png)

### A spatial view of the library

![Relationship graph connecting papers, authors, topics, and tags](images/product/relationship-graph.png)

The graph connects papers to their authors, topics, tags, and related readings.

### Explicit, revocable sharing

![View-only reading dialog with optional conversation snapshots](images/product/share-reading.png)

A shared reading includes the current annotated PDF. Conversation snapshots
are opt-in; later private messages never appear in an existing link.

## On iPad

The library and paper workspace adapt to a tablet-sized screen:

| Library                                                                      | Paper and chat                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ![Papernook library on a tablet viewport](images/product/library-tablet.png) | ![Papernook paper and chat on a tablet viewport](images/product/paper-tablet.png) |

Open the paper in Safari. Papernook detects Apple Pencil input, enables Draw,
autosaves annotations, and keeps Chat available in its own tablet tab. WebDAV
is optional compatibility for external PDF apps.

## Guides

| Goal                                                        | Guide                                            |
| ----------------------------------------------------------- | ------------------------------------------------ |
| Learn the everyday capture, reading, chat, and sharing flow | [User guide](user-guide.md)                      |
| Invite a friend through a domain or Tailscale               | [Invite a friend](user-guide.md#invite-a-friend) |
| Install or rebuild the Safari/iOS Shortcut                  | [Add to Papernook Shortcut](shortcut.md)         |
| Annotate the live PDF with Apple Pencil                     | [iPad annotation guide](ipad-annotation.md)      |
| Put the app behind a public HTTPS domain safely             | [Public exposure hardening](public-exposure.md)  |
| Understand the security model or report a vulnerability     | [Security policy](../SECURITY.md)                |

## Owner checklist

- Keep `data/` backed up. The filesystem, not SQLite, is the source of truth.
- For a subscription CLI, log in on the Docker host first. Papernook checks
  both installation and authentication before calling the provider ready.
  Docker mounts only the selected provider's credential file; see
  `.env.example` for `CODEX_AUTH_FILE` and `CLAUDE_AUTH_FILE`.
- Use a long, unique `WEBDAV_PASS`.
- For a custom domain, set `PUBLIC_EXPOSURE`, `PAPERNOOK_PUBLIC_HOST`,
  `PAPERNOOK_PASSWORD`, `SESSION_SECRET`, and loopback port bindings before
  exposing the proxy.
- Generate friend links from **Settings → Invite a friend** while visiting the
  URL the friend will use.
- Rotate a capture token in Settings if it appears anywhere it should not.
- Readers can erase their own private data from Settings; admins can remove
  members completely. Shared confirmed papers remain with anonymized
  attribution.

## Screenshot contract

The images in this guide are browser snapshots of seeded, synthetic data—never
a private library. The Playwright journey verifies the public gate, profile
password-protected profile creation, local CLI detection, reading focus mode,
sharing, graph, setup cards, and tablet layouts.

```bash
npx playwright install chromium  # once per development machine
npm run test:e2e                 # compare the UI with committed screenshots
npm run screenshots              # intentionally regenerate docs/images
```

<p align="center"><a href="../README.md">← Project README</a></p>
