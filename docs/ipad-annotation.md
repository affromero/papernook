# iPad annotation over WebDAV

[← Documentation home](README.md)

papernook serves **only** `data/papers/` (your annotatable PDFs and rendered
exercise sheets) through an rclone WebDAV sidecar. Chats, crops, and canvases
never appear on the share.

## Where NOT to add it

Apple's built-in Files app cannot do this: its "Connect to Server" option
only supports SMB and rejects any https:// WebDAV address with "this URL is
not supported". The connection goes inside the PDF app itself.

## PDF Expert or Documents (recommended)

1. Install **Documents by Readdle** (free) or **PDF Viewer by Nutrient**
   (free, unlimited annotations). PDF Expert also works but is
   subscription-based.
2. Choose the address for the way this iPad reaches Papernook:

   | Setup                                       | WebDAV address                           |
   | ------------------------------------------- | ---------------------------------------- |
   | Custom domain with the example Caddy layout | `https://dav.papernook.example.com`      |
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

![WebDAV values ready to copy from the welcome flow](images/setup/welcome-webdav.png)

> **Important:** the app and WebDAV addresses must both be reachable through
> the selected route. A friend using Tailscale should use the server's
> Tailscale hostname or IP for both, not `dav.<tailscale-hostname>`.

For a nonstandard proxy layout, set `PAPERNOOK_WEBDAV_URL` in `.env`. Settings
and every new-reader welcome screen will use that exact address.

## Good to know

- **Exercises**: `<paper>.exercises.pdf` sits next to each paper — solutions
  go straight in with the Pencil.
- **More writing room**: use the canvas toolbar's _+ margin space_ /
  _+ blank page_ in papernook; the file grows without moving existing ink.
  If the button reports the file was just modified, the iPad was mid-save;
  wait a few seconds.
- **Moving papers**: rearranging files/folders on the share is safe. The
  scanner reconciles the library from disk; just keep a paper's PDF inside a
  topic folder.
- **Alternatives**: any app that writes standard PDF annotations over WebDAV
  works (PDF Viewer, GoodReader). GoodNotes does not; it keeps ink in its
  own format until exported, which is exactly what papernook exists to avoid.
