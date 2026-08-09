# Privacy policy — papernook Safari extension

The papernook extension collects no data.

- **No analytics, no telemetry, no third-party servers.** The extension makes
  no network request of its own to anyone except the papernook server URL you
  configure — your own self-hosted instance.
- **What it stores:** your papernook server URL, the auto-intercept toggle,
  and any extra sites you add for automatic opening, in Safari extension
  storage on your device (synced by Safari if you enable extension syncing).
- **What it does:** rewrites PDF navigations to your papernook server's
  `/viewer` page via declarativeNetRequest rules (the browser applies these;
  the extension never sees page content), and the toolbar button opens the
  current tab's URL on your server.
- **Your papernook server** is operated by you; the papers you capture and
  annotations you make live on your own machine. See the repository README
  for what the server itself stores.

Questions: open an issue at https://github.com/affromero/papernook.
