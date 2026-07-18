import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * Gate everything behind a profile session except: the login/picker page, the
 * session + profile APIs it needs, static assets, and /add (which carries its
 * own per-profile capture token and is validated in the route).
 */

const PUBLIC_PATHS = ["/login", "/add", "/api/v1/session", "/api/v1/profiles"];

export const config = {
  runtime: "nodejs",
  matcher: [
    "/((?!_next/|avatars/|favicon\\.ico|manifest\\.webmanifest|sw\\.js).*)",
  ],
};

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return NextResponse.next();
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token && verifySessionToken(token)) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}
