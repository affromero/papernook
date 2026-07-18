import { NextResponse, type NextRequest } from "next/server";
import { profileForCaptureToken } from "@/lib/auth/users";
import { capture } from "@/lib/capture";
import { CaptureError } from "@/lib/capture/download";
import { confirmationPage, errorPage } from "./pages";

/**
 * The one-tap capture endpoint. Authenticated by the per-profile capture
 * token (works logged-out: the Shortcut and bookmarklet land here from any
 * browser). GET and POST behave identically so both clients stay trivial.
 */

export const dynamic = "force-dynamic";

async function handle(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  let url = params.get("url") ?? "";
  let token = params.get("token") ?? "";
  if (request.method === "POST") {
    const form = await request.formData().catch(() => null);
    url = (form?.get("url") as string | null) ?? url;
    token = (form?.get("token") as string | null) ?? token;
  }

  const profile = profileForCaptureToken(token);
  if (!profile) {
    return new NextResponse(
      errorPage(
        "Invalid capture token. Re-copy your bookmarklet or Shortcut from Settings.",
      ),
      {
        status: 401,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    );
  }
  if (!url) {
    return new NextResponse(errorPage("No URL provided."), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  try {
    const result = await capture(url, profile.username);
    return new NextResponse(confirmationPage(result, token), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    const message =
      err instanceof CaptureError
        ? err.message
        : `Capture failed: ${err instanceof Error ? err.message : "unknown error"}`;
    return new NextResponse(errorPage(message), {
      status: err instanceof CaptureError ? 422 : 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
