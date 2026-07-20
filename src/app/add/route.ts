import { NextResponse, type NextRequest } from "next/server";
import { profileForCaptureToken } from "@/lib/auth/users";
import {
  consumeRequestLimit,
  recordFailure,
  retryAfterMs,
} from "@/lib/auth/rate-limit";
import { capture } from "@/lib/capture";
import { CaptureError } from "@/lib/capture/download";
import { confirmationPage, errorPage } from "./pages";

/**
 * The one-tap capture endpoint. Authenticated by the per-profile capture
 * token (works logged-out: the Shortcut and bookmarklet land here from any
 * browser). Credentials are accepted only in POST bodies so they never enter
 * browser history, proxy logs, analytics URLs, or referrer headers.
 */

export const dynamic = "force-dynamic";

async function handle(request: NextRequest): Promise<NextResponse> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > 32 * 1024) {
    return html(errorPage("Request body too large."), 413);
  }
  const form = await request.formData().catch(() => null);
  const url = (form?.get("url") as string | null) ?? "";
  const token = (form?.get("token") as string | null) ?? "";

  const ipKey = `ip:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"}`;
  if (retryAfterMs(ipKey) > 0) {
    return html(errorPage("Too many attempts. Try again later."), 429);
  }
  const profile = profileForCaptureToken(token);
  if (!profile) {
    recordFailure(ipKey);
    return html(
      errorPage(
        "Invalid capture token. Re-copy your bookmarklet or Shortcut from Settings.",
      ),
      401,
    );
  }
  const quotaWait = Math.max(
    consumeRequestLimit(`capture-ip:${ipKey}`, 30, 60 * 60_000),
    consumeRequestLimit(`capture-profile:${profile.username}`, 20, 60 * 60_000),
  );
  if (quotaWait > 0) {
    return html(errorPage("Capture limit reached. Try again later."), 429);
  }
  if (!url) {
    return html(errorPage("No URL provided."), 400);
  }

  try {
    const result = await capture(url, profile.username);
    return html(confirmationPage(result, token), 200);
  } catch (err) {
    if (!(err instanceof CaptureError)) {
      console.error("papernook capture failed:", err);
    }
    const message =
      err instanceof CaptureError
        ? err.message
        : `Capture failed: ${err instanceof Error ? err.message : "unknown error"}`;
    return html(errorPage(message), err instanceof CaptureError ? 422 : 500);
  }
}

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
