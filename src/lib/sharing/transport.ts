import { fetchPublicUrl } from "../capture/download";
import { readBoundedResponse } from "../capture/bounded-response";
import { MAX_BUNDLE_BYTES, SharingError } from "./schema";
import { withSharingTransfer } from "./storage";

export function parseShareUrl(raw: string): {
  url: URL;
  topic: string;
  slug: string;
  shareId: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SharingError("Enter a valid Papernook sharing link.");
  }
  const match =
    /^\/share\/([a-z0-9][a-z0-9-]{0,79})\/([a-z0-9][a-z0-9-]{0,79})\/([a-f0-9]{64})\/?$/.exec(
      url.pathname,
    );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  )
    throw new SharingError(
      "Use an HTTPS Papernook sharing link without credentials or extra parameters.",
    );
  return { url, topic: match[1], slug: match[2], shareId: match[3] };
}

export async function exchange(
  raw: string,
  body: unknown,
  token?: string,
  authorize?: () => void,
): Promise<unknown> {
  return withSharingTransfer(
    () => exchangeRequest(raw, body, token, authorize),
    "outgoing",
  );
}

async function exchangeRequest(
  raw: string,
  body: unknown,
  token?: string,
  authorize?: () => void,
): Promise<unknown> {
  const { url, topic, slug, shareId } = parseShareUrl(raw);
  url.pathname = `/api/v1/shares/${topic}/${slug}/${shareId}/exchange`;
  const allowlist = (process.env.PAPERNOOK_SHARING_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  try {
    const fetched = await fetchPublicUrl(
      url.toString(),
      AbortSignal.timeout(60_000),
      {
        body: JSON.stringify(body),
        token,
        authorize,
        trustedOrigin: allowlist.includes(url.origin) ? url.origin : undefined,
      },
    );
    const bytes = await readBoundedResponse(
      fetched.response,
      MAX_BUNDLE_BYTES,
      fetched.close,
    );
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new SharingError(
        "The sharing server returned an invalid response.",
        502,
      );
    }
    if (!fetched.response.ok) {
      const message =
        fetched.response.status === 403
          ? "The sharing server denied this operation. Check your approval status and whether the annotation belongs to another contributor."
          : fetched.response.status === 404
            ? "The shared paper is no longer available."
            : fetched.response.status === 409 || fetched.response.status === 412
              ? "The shared paper changed elsewhere. Reload before saving."
              : fetched.response.status === 429
                ? "The sharing server is busy. Try again later."
                : fetched.response.status === 413
                  ? "This reading or conversation exceeds a sharing limit. Reduce its size or stop sharing the oversized conversation."
                  : "The sharing server rejected the request.";
      throw new SharingError(
        message,
        fetched.response.status >= 400 && fetched.response.status < 500
          ? fetched.response.status
          : 502,
      );
    }
    return value;
  } catch (error) {
    if (error instanceof SharingError) throw error;
    throw new SharingError(
      "Could not reach the sharing server securely. Check HTTPS, connectivity, and the administrator's trusted-origin settings.",
      502,
    );
  }
}
