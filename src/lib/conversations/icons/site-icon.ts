import { Parser } from "htmlparser2";
import { fetchPublicUrl } from "@/lib/capture/download";
import { readBoundedResponse } from "@/lib/capture/bounded-response";
import { siteIconSite } from "@/lib/chat/layout/site-icon";
import { downloadAsset } from "../assets";
import { imageMime } from "../images";

let inflight = 0;
export class SiteIconBusyError extends Error {
  constructor() {
    super("Too many site icons are loading. Try again shortly.");
  }
}

/** Resolve the site's declared icon using the guarded, bounded HTTP layer. */
export async function loadSiteIcon(
  origin: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mime: string }> {
  const site = siteIconSite(origin);
  if (!site || site.origin !== origin)
    throw new Error("Use an HTTPS site origin.");
  if (inflight >= 3) throw new SiteIconBusyError();
  inflight++;
  try {
    const fetched = await fetchPublicUrl(origin, signal);
    if (!fetched.response.ok) {
      try {
        await fetched.response.body?.cancel();
      } finally {
        await fetched.close();
      }
      throw new Error(`Site returned HTTP ${fetched.response.status}.`);
    }
    const html = (
      await readBoundedResponse(fetched.response, 512 * 1024, fetched.close)
    ).toString("utf8");
    let base = fetched.url;
    let declaredBase = false;
    let icon: string | undefined;
    const parser = new Parser({
      onopentag(name, attributes) {
        if (name === "base" && attributes.href && !declaredBase) {
          const candidate = new URL(attributes.href, fetched.url);
          if (/^https?:$/.test(candidate.protocol)) base = candidate.href;
          declaredBase = true;
        }
        if (
          name === "link" &&
          !icon &&
          attributes.href &&
          attributes.rel?.toLowerCase().split(/\s+/).includes("icon")
        )
          icon = new URL(attributes.href, base).href;
      },
    });
    parser.end(html);
    const url = icon ?? new URL("/favicon.ico", fetched.url).href;
    const downloaded = await downloadAsset(
      { kind: "image", name: "Site icon", url },
      { maxBytes: 2 * 1024 * 1024, signal },
    );
    const mime =
      imageMime(downloaded.bytes) ??
      (downloaded.mime === "image/svg+xml" ? "image/svg+xml" : undefined);
    if (!mime)
      throw new Error("The site did not return a supported icon image.");
    return { bytes: downloaded.bytes, mime };
  } finally {
    inflight--;
  }
}
