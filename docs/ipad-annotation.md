# iPad annotation

[← Documentation home](README.md)

Open Papernook in Safari, choose a paper, and use the same annotation toolbar
as desktop. Apple Pencil input enables Draw automatically. Highlights, text,
and ink autosave into the PDF, while Reading and Chat remain available as
separate tablet tabs.

## Optional external PDF apps

When WebDAV is fully configured, Settings shows an **External PDF app
compatibility** disclosure. Papernook serves only `data/papers/` through that
route; chats and private companion files never appear on it. Apple Files does
not support WebDAV, so add the connection inside the PDF app.

1. Install **Documents by Readdle** (free) or **PDF Viewer by Nutrient**
   (free, unlimited annotations). PDF Expert also works but is
   subscription-based.
2. Choose the address for the way this iPad reaches Papernook:

   | Setup                                       | WebDAV address                           |
   | ------------------------------------------- | ---------------------------------------- |
   | Custom domain with the example Caddy layout | `https://dav-papernook.example.com`      |
   | Tailscale                                   | `http://<tailscale-hostname-or-ip>:8080` |
   | Same LAN                                    | `http://<lan-hostname-or-ip>:8080`       |

3. In Documents: **+ (Plus) → Add Connection → WebDAV Server**. In PDF
   Viewer / PDF Expert: add a WebDAV location from the connections screen.
   Then fill in:
   - URL: the address selected above
   - Login / password: the `WEBDAV_USER` / `WEBDAV_PASS` from the server's
     `.env` (the installer set these).
4. Browse to a topic folder, open a paper, write with the Pencil.
5. Saving writes standard PDF annotations **into the same file on your
   server**. papernook, other devices, and future exports all see them.
   There is no export step and no proprietary format.

> **Important:** the app and WebDAV addresses must both be reachable through
> the selected route. A friend using Tailscale should use the server's
> Tailscale hostname or IP for both, not `dav-<tailscale-hostname>`.

For a custom public domain, set `PAPERNOOK_WEBDAV_URL` in `.env`. Settings and
every new-reader welcome screen will use that exact address. Papernook requires
the explicit URL because it cannot safely infer a sibling hostname from every
possible domain.

## Good to know

- **Exercises**: `<paper>.exercises.pdf` sits next to each paper — solutions
  go straight in with the Pencil.
- **Do not rename or move papers over WebDAV**: WebDAV exposes only the PDF
  tree, while each paper's metadata and private companion files live in a
  separate library tree. A WebDAV-only move would split those two halves.
  Organize papers through Papernook; filesystem administrators must move the
  PDF and companion directory together.
- **Alternatives**: any app that writes standard PDF annotations over WebDAV
  works (PDF Viewer, GoodReader). GoodNotes does not; it keeps ink in its
  own format until exported, which is exactly what papernook exists to avoid.
