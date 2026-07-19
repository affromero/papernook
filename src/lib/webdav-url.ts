/**
 * Derive the WebDAV endpoint shown in Settings and onboarding.
 *
 * Public-domain installs conventionally use a dav subdomain. Tailscale Serve
 * gives the app an HTTPS *.ts.net URL while forwarding WebDAV as raw HTTP on
 * port 8080, so it must keep the same hostname instead.
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
    return `https://dav.${app.hostname}`;
  }
  return `${app.protocol}//${app.hostname}:8080`;
}
