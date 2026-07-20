import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/users";
import {
  CanvasConfigError,
  configuredCanvasLicense,
  setCanvasLicenseKey,
  tldrawLicenseRequired,
} from "@/lib/canvas/config";

export const dynamic = "force-dynamic";

const schema = z.object({
  licenseKey: z.string().trim().min(1).max(10_000).nullable(),
});

function licenseRequired(request: NextRequest): boolean {
  const protocol =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
    request.nextUrl.protocol.replace(":", "");
  const hostname =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ??
    request.headers.get("host") ??
    request.nextUrl.host;
  return tldrawLicenseRequired(protocol, hostname);
}

function response(
  admin: boolean,
  requiredForThisOrigin: boolean,
): NextResponse {
  try {
    const config = configuredCanvasLicense();
    return NextResponse.json(
      {
        configured: config.licenseKey !== null,
        source: config.source,
        admin,
        requiredForThisOrigin,
        ...(admin ? { licenseKey: config.licenseKey } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof CanvasConfigError
            ? error.message
            : "The canvas configuration could not be loaded.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile) {
    return NextResponse.json(
      { error: "Not signed in." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return response(isAdmin(profile), licenseRequired(request));
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile) {
    return NextResponse.json(
      { error: "Not signed in." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!isAdmin(profile)) {
    return NextResponse.json(
      { error: "Admin only." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: "Enter a valid tldraw license key." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    setCanvasLicenseKey(body.data.licenseKey);
    return response(true, licenseRequired(request));
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof CanvasConfigError
            ? error.message
            : "The canvas configuration could not be saved.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
