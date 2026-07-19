# iPad annotation over WebDAV

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
2. In Documents: **+ (Plus) → Add Connection → WebDAV Server**. In PDF
   Viewer / PDF Expert: add a WebDAV location from the connections screen.
   Then fill in:
   - URL: `http://<your-host>:8080` (or `https://dav.<your-domain>` if you
     exposed it through Caddy)
   - Login / password: the `WEBDAV_USER` / `WEBDAV_PASS` from the server's
     `.env` (the installer set these).
3. Browse to a topic folder, open a paper, write with the Pencil.
4. Saving writes standard PDF annotations **into the same file on your
   server**. papernook, other devices, and future exports all see them.
   There is no export step and no proprietary format.

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
