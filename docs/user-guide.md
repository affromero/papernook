# User guide

## Daily use

**Add a paper from Safari (iPad / iPhone / Mac).** On any arxiv or paper page: Share → **Add to papernook** (the Shortcut — see [shortcut.md](shortcut.md)). A confirmation page appears with the proposed topic folder, tags, and summary. Tap **Accept into library** (or pick another folder / type a new one). Done — the paper is filed, the PDF is on the WebDAV share, and starter questions wait in its chat.

**Add a paper from Chrome (desktop).** Click the **📚 Add to papernook** bookmark in the bookmarks bar (drag it there once, from Settings → capture). Same confirmation page, same one tap.

**Read and annotate on the iPad.** Open PDF Expert → the papernook WebDAV connection → your topic folder → the PDF. Write with the Pencil. It autosaves into the same file on your server — no export, ever. See [ipad-annotation.md](ipad-annotation.md).

**Chat.** Open the paper in papernook (library card, or the link on the confirmation page). The chat panel sits beside the PDF: ask anything, tap a starter question, or paste a screenshot you marked up with iOS markup and ask _"explain this"_. Every conversation is listed in the dropdown — pick any old one to resume. Chats are yours; other profiles can't see them.

**Canvas.** _Open canvas_ on the paper page lays the pages on an infinite tldraw board. Add sticky notes, paste YouTube links (they embed), draw with the Pencil. Select any region or shapes → **Explain selection ↦ chat**. Everything persists to the paper's `canvas.json`.

**Exercises.** On any assistant answer: **Save as exercise**. It lands in `<paper>.exercises.pdf` next to the paper on the WebDAV share — write your solutions with the Pencil. Need more room in the paper itself? Canvas toolbar → **+ margin space** or **+ blank page** (existing ink never moves).

## Inviting a friend

Their chats will be private; the paper library, folders, tags, and annotations are shared.

1. **Access.** Private mode: invite them to your Tailscale network (Tailscale admin → Invite) and give them the app URL. Public mode: give them the URL — they must set a password on first login.
2. **Profile.** They open papernook → **Add profile** → name + animal.
3. **Their wizard runs automatically**: agent check, _their own_ bookmarklet and Shortcut token (captures are filed under their name), and the iPad walkthrough.
4. That's it. They capture, chat, and annotate exactly like you.

Rotate or view your capture token any time in **Settings**.
