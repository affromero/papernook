import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { crossSiteMutation } from "@/lib/auth/request-security";
import { clientIp } from "@/lib/auth/request-security";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";

/**
 * Gate everything behind a profile session except: the login/picker page, the
 * session + profile APIs it needs, static assets, and /add (which carries its
 * own per-profile capture token and is validated in the route).
 */

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/v1/session",
  "/api/v1/gate",
  "/api/v1/profiles",
  "/api/v1/health",
]);

const DEFAULT_PUBLIC_REQUEST_LIMIT = 120;

export function publicRequestLimit(): number {
  const configured = Number(process.env.PAPERNOOK_PUBLIC_REQUEST_LIMIT);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_PUBLIC_REQUEST_LIMIT;
}

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' ws: wss:",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
    }`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join("; ");
}

function secureResponse(response: NextResponse, csp: string): NextResponse {
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

function continueRequest(request: NextRequest, csp: string): NextResponse {
  const requestHeaders = new Headers(request.headers);
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  if (nonce) requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  return secureResponse(
    NextResponse.next({ request: { headers: requestHeaders } }),
    csp,
  );
}

export const config = {
  matcher: [
    "/((?!_next/|avatars/|vendor/|favicon\\.ico|icon\\.svg|apple-icon\\.png|logo\\.(?:svg|png)|manifest\\.webmanifest|sw\\.js).*)",
  ],
};

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce);
  const { pathname } = request.nextUrl;
  const publicRequest = process.env.PUBLIC_EXPOSURE === "true";
  const privateSharePath =
    !publicRequest &&
    (pathname === "/share" ||
      pathname.startsWith("/share/") ||
      pathname === "/api/v1/shares" ||
      pathname.startsWith("/api/v1/shares/") ||
      pathname === "/invite" ||
      pathname.startsWith("/invite/"));
  if (publicRequest) {
    const wait = consumeRequestLimit(
      `request:${clientIp(request)}`,
      publicRequestLimit(),
      60_000,
    );
    if (wait > 0) {
      return secureResponse(
        NextResponse.json(
          { error: "Too many requests." },
          {
            status: 429,
            headers: { "Retry-After": String(Math.ceil(wait / 1000)) },
          },
        ),
        csp,
      );
    }
  }
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    pathname !== "/add" &&
    pathname !== "/add/confirm" &&
    pathname !== "/add/status" &&
    crossSiteMutation(request)
  ) {
    return secureResponse(
      NextResponse.json(
        { error: "Cross-site request rejected." },
        { status: 403 },
      ),
      csp,
    );
  }
  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname === "/add" ||
    pathname === "/add/confirm" ||
    pathname === "/add/status" ||
    privateSharePath
  ) {
    const response = continueRequest(request, csp);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token && verifySessionToken(token)) {
    return continueRequest(request, csp);
  }
  if (pathname.startsWith("/api/")) {
    return secureResponse(
      NextResponse.json({ error: "Not signed in." }, { status: 401 }),
      csp,
    );
  }
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return secureResponse(NextResponse.redirect(login), csp);
}
