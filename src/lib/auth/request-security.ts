import { NextResponse, type NextRequest } from "next/server";

const IP_RE = /^[0-9a-f:.]{2,64}$/i;

/**
 * Number of trusted reverse-proxy hops in front of the app. A client can forge
 * the left (earlier) X-Forwarded-For entries but not the ones the trusted
 * proxies appended, so we count from the right. Default 1 = a single Caddy;
 * raise it for e.g. Cloudflare-in-front-of-Caddy.
 */
function trustedProxyHops(): number {
  const configured = Number(process.env.TRUSTED_PROXY_HOPS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 1;
}

/**
 * The client IP used to key rate-limits and lockouts. Derived only from the
 * proxy-appended tail of X-Forwarded-For — never X-Real-IP, which Caddy's
 * default reverse_proxy leaves untouched and is therefore fully
 * client-controlled. A missing or too-short chain fails closed to "unknown".
 */
export function clientIp(request: NextRequest): string {
  const chain = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!chain || chain.length === 0) return "unknown";
  const candidate = chain[chain.length - trustedProxyHops()];
  return candidate && IP_RE.test(candidate)
    ? candidate.toLowerCase()
    : "unknown";
}

export function crossSiteMutation(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return true;

  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    const host =
      request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const proto =
      request.headers.get("x-forwarded-proto") ??
      request.nextUrl.protocol.replace(":", "");
    return (
      !host ||
      originUrl.host.toLowerCase() !== host.toLowerCase() ||
      originUrl.protocol !== `${proto}:`
    );
  } catch {
    return true;
  }
}

export function rejectCrossSiteMutation(
  request: NextRequest,
): NextResponse | null {
  if (!crossSiteMutation(request)) return null;
  return NextResponse.json(
    { error: "Cross-site request rejected." },
    { status: 403 },
  );
}

export async function authenticationFailureDelay(): Promise<void> {
  const delay = 350 + Math.floor(Math.random() * 200);
  await new Promise((resolve) => setTimeout(resolve, delay));
}
