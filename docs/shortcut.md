# The "Add to papernook" Shortcut (Safari / iPhone / iPad / Mac)

Two ways to get it. The import link is the normal path; the manual recipe
exists for instances that have not published a Shortcut link yet.

Quick alternative that needs no Shortcut at all: copy any paper link and
paste it into the **Add paper** box at the top of your library.

## Import it (two taps)

1. On the iPhone/iPad, open the **Get the Shortcut** link shown in the
   papernook wizard or Settings.
2. Tap **Add Shortcut**. Answer the two import questions:
   - **Server**: your papernook URL (shown next to the link).
   - **Token**: your capture token (on the Settings page).

Done. On any paper page: Share → **Add to papernook** → the confirmation
page proposes the filing → **Accept into library**.

## Publish the importable Shortcut (owner, once)

Built once on any of the owner's Apple devices, then shared for everyone:

1. Build the Shortcut with the manual recipe below, but create two **Text**
   actions first, named `Server` and `Token`, and reference them in the URL
   and form fields instead of hardcoding values.
2. Open the Shortcut's ⓘ panel → **Import Questions** → add both Text
   actions as import questions. This is what makes the shared link prompt
   each person for their own server and token at import time.
3. Share the Shortcut → **Copy iCloud Link**.
4. Put that link in Infisical as `PAPERNOOK_SHORTCUT_URL` (prod env) and
   redeploy. The wizard and Settings begin showing the Get the Shortcut
   button automatically.

## Manual recipe (fallback)

1. **New Shortcut** → ⓘ panel → enable **Show in Share Sheet** → accepted
   types: **URLs**. Rename it _Add to papernook_.
2. Add **Get Contents of URL**:
   - URL: `https://<your-papernook-host>/add`
   - Method: **POST**
   - Request Body: **Form**
     - field `url` → variable **Shortcut Input**
     - field `token` → your capture token
3. Add **Show Web Page** with **Contents of URL** as input.

## Notes

- Capture takes about 10 to 30 s (download + AI analysis); the Shortcut
  waits and then shows the confirmation page.
- Works identically on macOS Safari (Share menu) and iPadOS.
- _Invalid capture token_: re-copy the token from Settings (it may have been
  rotated), or re-import the Shortcut and answer the questions again.
