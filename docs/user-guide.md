# User guide

[← Documentation home](README.md)

## Daily use

### Add a paper

- **From anywhere:** copy an arXiv/OpenReview URL, direct PDF URL, or publisher
  page that exposes a PDF link; paste it into **Add paper**, then select
  **Add paper**.
- **From Safari on iPhone, iPad, or Mac:** Share →
  **Add to Papernook**. Install it once from **Get the Shortcut**; see the
  [Shortcut guide](shortcut.md).
- **From Chrome on desktop:** install the
  [browser extension](../extension/README.md#chrome) to redirect supported PDFs
  automatically or use its toolbar button anywhere. Settings retains a
  bookmarklet fallback for managed browsers that cannot install extensions.

Papernook opens a confirmation page with the proposed topic, tags, summary,
related papers, and starter questions. Review it and select
**Accept into library**.

![Library with the Add paper field, search, topics, and tags](images/product/library.png)

### Read, annotate, and ask

Open a library card to put the PDF and its chat side by side. Ask a starter
question, continue an earlier conversation, or paste a marked-up screenshot
and ask what it means.

![A paper open beside its per-profile conversation](images/product/paper-and-chat.png)

On desktop, select **Focus reading** to give the PDF the full workspace and
**Show chat** to restore it. On a tablet, use the persistent **Reading** and
**Chat** tabs.

![Full-width paper view with chat hidden](images/product/paper-focus.png)

Switch to **Canvas** to arrange notes, drawings, screenshots, links, and video
beside the same paper conversation. Canvas keeps its own shared objects while
the annotated PDF remains the source of truth in Reader.

![The shared paper canvas with drawing and media tools](images/product/canvas.png)

To write with Apple Pencil, open the paper in Safari and start drawing.
Papernook enables Draw for pen input and autosaves into the PDF. WebDAV is
available as optional external-app compatibility; see the
[iPad annotation guide](ipad-annotation.md).

### Explore and practice

- On an assistant answer, select **Save as exercise**. Papernook renders
  `<paper>.exercises.pdf` beside the paper over WebDAV.
- Open **Graph** to move through connections among papers, authors, topics,
  tags, and related readings.

### Share a reading

Select **Share** on a paper, then **Create link & copy**. The link is
view-only and revocable. The current annotated PDF is included; conversation
snapshots stay off unless you select them.

No login is required to open the link. Its unguessable share id is the
capability to read that one shared paper.

![Share dialog showing its view-only boundary](images/product/share-reading.png)

## Invite a friend

First choose the route that matches your server:

| Your setup                                             | Use this flow                            |
| ------------------------------------------------------ | ---------------------------------------- |
| Papernook opens at an HTTPS domain from any browser    | [Custom domain](#option-a-custom-domain) |
| Papernook is reachable only after connecting Tailscale | [Tailscale](#option-b-tailscale)         |

The result is the same in both cases:

- **Shared:** papers, folders, tags, annotations, and exercises.
- **Organized by profile:** chats, capture token, and Zotero connection.
- **One credential:** the admin-owned `PAPERNOOK_PASSWORD` instance access
  password.

Profiles are a courtesy boundary, like viewer profiles on a streaming service.
They are not a security boundary. Anyone with the instance password can select
any profile and read its chats.

### Option A: custom domain

Before inviting anyone, the owner should finish
[public exposure hardening](public-exposure.md), including
`PAPERNOOK_PASSWORD`.

1. Open Papernook through its public URL, such as
   `https://papernook.example.com`.
2. Open **Settings → Invite a friend** and send the signed invite link or QR.
   It opens the access gate for seven days without revealing the instance
   password. Alternatively, share the instance password through a separate,
   secure channel.
3. Your friend opens the invite, selects **Add profile**, and chooses a name
   and animal.
4. They follow the welcome screen.

![Domain invite card with a QR code and numbered next steps](images/setup/invite-domain.png)

> **Expected result:** the new profile opens its own welcome flow with a
> personal capture token and reader setup.

### Option B: Tailscale

Production sessions require HTTPS, so publish the app through Tailscale Serve
instead of sending raw port `3000`:

1. On the Papernook server, run:

   ```bash
   tailscale serve --bg 3000
   tailscale serve --bg --tcp=8080 tcp://127.0.0.1:8080
   tailscale serve status
   ```

   The status output gives the app an HTTPS `.ts.net` URL and keeps WebDAV on
   port `8080`.

2. In the [Tailscale Machines page](https://login.tailscale.com/admin/machines),
   open the Papernook server, select **Share**, and send the generated link or
   email invitation.
3. Your friend accepts it and installs Tailscale on each device that will use
   Papernook.
4. Send the HTTPS app address from `tailscale serve status`, such as
   `https://papernook-server.example-tailnet.ts.net`.
5. Send an invite link from **Settings → Invite a friend**, or share the
   instance password securely. They open the address, pass the gate, select
   **Add profile**, choose a name and animal, and follow the welcome screen.
6. For iPad annotation, use
   `http://papernook-server.example-tailnet.ts.net:8080` as the WebDAV address
   and share the common `WEBDAV_USER` and `WEBDAV_PASS` securely.

If MagicDNS does not resolve a shared machine's short name, use its full
`<hostname>.<tailnet>.ts.net` name or Tailscale IP. If the person is already a
trusted member of your tailnet, skip the machine-sharing step and send the
address.

Machine sharing limits access to that machine. Inviting a user to the tailnet
can expose more devices and services unless your access controls restrict
them; see Tailscale's
[inviting-versus-sharing guide](https://tailscale.com/docs/reference/inviting-vs-sharing)
and [machine-sharing steps](https://tailscale.com/docs/features/sharing).

> **Using a domain and Tailscale together?** Authentication is identical on
> the public hostname and the Tailscale Serve hostname. Host headers never
> select a passwordless route.

### If a friend cannot connect

1. Confirm they can open the app URL before setting up WebDAV.
2. For Tailscale, confirm the shared machine appears online in their Machines
   list and try its Tailscale IP.
3. Verify their invite link is valid or they have the current instance access
   password.
4. For Tailscale, run `tailscale serve status` and open the listed HTTPS URL.
   For a domain, confirm HTTPS reaches Caddy.
5. Test WebDAV separately with the URL for the same route and verify the
   `WEBDAV_USER` and `WEBDAV_PASS`.

View or rotate your personal capture token at any time in **Settings**.

## Delete a profile and its per-profile data

Every reader can open **Settings → Delete my profile**, type their username,
and erase their own personal data. An admin can use **Settings → Members** to
remove another reader completely.

Deletion removes the profile, session access, capture token, Zotero
configuration and cursor, chats, pasted chat crops, unconfirmed captures,
owned share links, and stored login-rate state. Confirmed PDFs, annotations,
canvases, exercises, summaries, and metadata remain part of the shared
library; the deleted username is removed from their capture attribution. If
the admin deletes their own profile, the oldest remaining profile becomes the
admin. Deletion waits for active capture and Zotero work to stop and clean up,
and revokes that profile's sessions on every device.
