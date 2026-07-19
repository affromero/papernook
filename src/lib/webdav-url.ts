/**
 * Derive the WebDAV endpoint shown in Settings and onboarding.
 *
 * Public-domain installs must configure their WebDAV URL explicitly because
 * an app hostname does not contain enough information to derive another safe
 * hostname. Tailscale Serve gives the app an HTTPS *.ts.net URL while
 * forwarding WebDAV as raw HTTP on port 8080, so it keeps the same hostname.
 */
export function resolveWebdavUrl(
  appUrl: string,
  configuredUrl?: string,
): string {
  if (configuredUrl) {
    const explicit = new URL(configuredUrl);
    if (explicit.protocol !== "http:" && explicit.protocol !== "https:") {
      throw new Error("PAPERNOOK_WEBDAV_URL must use http or https.");
    }
    return explicit.toString().replace(/\/$/, "");
  }

  const app = new URL(appUrl);
  if (app.hostname.endsWith(".ts.net")) {
    return `http://${app.hostname}:8080`;
  }
  if (!app.port || app.port === "443") {
    throw new Error(
      "PAPERNOOK_WEBDAV_URL is required for custom HTTPS domains.",
    );
  }
  return `${app.protocol}//${app.hostname}:8080`;
}
