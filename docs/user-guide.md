# User guide

[← Documentation home](README.md)

## Daily use

### Import a conversation

Open **Conversations** and paste a public ChatGPT or Claude share URL. Submit
the import to save a private source snapshot and open its Papernook page.
The original URL stays available through **Original share**. Removing the share
or deleting the original conversation later does not delete the imported copy.
Papers and Conversations have independent topics, tags and searches.

If the provider blocks access or changes its share format, Papernook reports the
import error. You can explicitly upload or paste a Markdown/text transcript,
ChatGPT or Claude conversation JSON, or a Codex JSONL session export. The importer
does not sign into your provider account. Source attachments that are absent from
the export are unavailable; their contents cannot be reconstructed from a link.

Ask follow-up questions beside the saved source. Responses use the AI configured
in Settings and stay private to your profile. The imported source remains a
snapshot. **Export HTML / Save as PDF** downloads a formatted HTML file including
saved follow-ups. Open that file and use the browser print menu to save a PDF.
Markdown and JSON exports are also available.

A shortcut can open `/conversations?import=<encoded-share-url>` on your instance
to prefill the import form. Opening this address alone does not create a document.

### Read without internet

While online, open a paper or conversation and choose **Available offline**.
Wait for **Saved on this device** before disconnecting. A paper download includes
its current PDF, extracted text, summary and your saved chats. A conversation
download includes its source transcript and saved follow-ups. Approved local chat
attachments are embedded; external image links are not fetched automatically.

Use **Downloads** to inspect the saved library. When the server is unreachable,
Papernook opens this library automatically. Downloaded papers and conversations
remain in separate tabs with their own categories and search. You can read a PDF,
its text and existing chats, or export HTML and PDF files. Sending AI questions
and editing annotations require a connection. The reader restores the online
document when connectivity returns and the profile session is still valid.

**Settings → Offline storage** lists downloaded items, their sizes and save dates.
Update a download to capture recent changes, remove individual items, or choose
**Clear all downloads**. These controls only remove device copies. They do not
delete documents or conversations from the server. While the app is open online,
downloads older than 15 minutes are refreshed; update failures are shown and keep
the last complete copy.

Downloads live in browser-managed storage on this device. They are not a visible
folder in the phone's Files app. Export PDF or HTML to keep independent files.
Changing profiles or logging out clears private downloads, including in other
open tabs. Browsers may reclaim stored data when the device is low on space.
Offline support requires HTTPS (or localhost for development) and a browser that
supports service workers and IndexedDB. Install Papernook on your home screen
and open Downloads once before a trip to check the documents you need.

### Add a paper

- **From anywhere:** copy an arXiv/OpenReview URL, direct PDF URL, or publisher
  page that exposes a PDF link; paste it into **Add paper**, then select
  **Add paper**.
- **From Safari or Chrome on desktop:** install the
  [browser extension](../extension/README.md) to redirect supported PDFs
  automatically or use its toolbar button anywhere. Settings retains a
  bookmarklet fallback for managed browsers that cannot install extensions.
- **From an iPhone or iPad:** Share → **Add to papernook**. Install it once
  from **Get the Shortcut**; see the [Shortcut guide](shortcut.md). The same
  Shortcut works from Safari's Share menu on a Mac.

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

### Explore

- Open **Graph** to move through connections among papers, authors, topics,
  tags, and related readings.
- Open **Discover** for AI suggestions of papers you do not have yet, grounded
  in the library. Each suggestion carries its source link, so adding one runs
  the same capture flow as any other paper.

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
