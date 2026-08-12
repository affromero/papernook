import { NextResponse, type NextRequest } from "next/server";

const IP_RE = /^[0-9a-f:.]{2,64}$/i;

/**
 * Number of trusted reverse-proxy hops in front of the app. A client can forge
 * the left (earlier) X-Forwarded-For entries but not the ones the trusted
 * proxies appended, so we count from the right. Default 1 = a single Caddy,
 * matching the loopback-plus-TLS-proxy deployment; raise it for e.g.
 * Cloudflare-in-front-of-Caddy, and set it to 0 when the app port is exposed
 * directly, where every entry in the header is client-authored.
 */
function trustedProxyHops(): number {
  const configured = Number(process.env.TRUSTED_PROXY_HOPS);
  if (!Number.isSafeInteger(configured) || configured < 0) return 1;
  return configured;
}

/**
 * The client IP used to key rate-limits and lockouts. Derived only from the
 * proxy-appended tail of X-Forwarded-For — never X-Real-IP, which Caddy's
 * default reverse_proxy leaves untouched and is therefore fully
 * client-controlled. A missing or too-short chain fails closed to "unknown".
 *
 * With no proxy in front (TRUSTED_PROXY_HOPS=0) nothing in the header is
 * trustworthy: every client keys to "unknown" and shares one bucket. That
 * throttles everyone together rather than letting a single attacker mint a
 * fresh identity per request and walk straight past the limiter.
 */
export function clientIp(request: NextRequest): string {
  const hops = trustedProxyHops();
  if (hops === 0) return "unknown";
  const chain = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!chain || chain.length === 0) return "unknown";
  const candidate = chain[chain.length - hops];
  return candidate && IP_RE.test(candidate)
    ? candidate.toLowerCase()
    : "unknown";
}

/**
 * The lockout bucket for this client, or null when we cannot tell clients
 * apart. Without a trusted proxy every caller resolves to "unknown", and
 * locking that shared bucket would let one attacker shut everyone out — so
 * unidentified callers get no bucket, and stay bounded by the per-attempt
 * failure delay and the proxy's global request limit instead.
 */
export function lockoutKey(
  request: NextRequest,
  prefix: string,
): string | null {
  const ip = clientIp(request);
  return ip === "unknown" ? null : `${prefix}:${ip}`;
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
