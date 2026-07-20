import { NextResponse, type NextRequest } from "next/server";

const IP_RE = /^[0-9a-f:.]{2,64}$/i;

export function clientIp(request: NextRequest): string {
  const candidate =
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  return IP_RE.test(candidate) ? candidate.toLowerCase() : "unknown";
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
