# The "Add to papernook" Shortcut (Safari / iPhone / iPad / Mac)

Build once in the Shortcuts app (~1 minute). Your personal capture token is on
the papernook **Settings** page — keep it private; captures made with it are
filed as you.

1. **New Shortcut** → tap the ⓘ info panel → enable **Show in Share Sheet** →
   set accepted types to **URLs**. Rename it _Add to papernook_.
2. Add action **Get Contents of URL**:
   - URL: `https://<your-papernook-host>/add`
   - Method: **POST**
   - Request Body: **Form**
     - field `url` → variable **Shortcut Input**
     - field `token` → paste your capture token
3. Add action **Show Web Page** with **Contents of URL** as input.

Use it: on any paper page → Share → **Add to papernook** → the confirmation
page shows the AI's proposed filing → **Accept into library**.

Notes

- Capture takes ~10–30 s (download + AI analysis) — the Shortcut waits and
  then shows the confirmation page.
- Works identically on macOS Safari (Share menu) and iPadOS.
- If you see _Invalid capture token_, re-copy the token from Settings (it may
  have been rotated).
