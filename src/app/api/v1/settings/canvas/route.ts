import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin, verifyProfilePassword } from "@/lib/auth/users";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import {
  CanvasConfigError,
  configuredCanvasLicense,
  setCanvasLicenseKey,
} from "@/lib/canvas/config";

export const dynamic = "force-dynamic";

const schema = z.object({
  licenseKey: z.string().trim().min(1).max(10_000).nullable(),
  password: z.string().max(200).optional(),
});

function response(admin: boolean): NextResponse {
  try {
    const config = configuredCanvasLicense();
    return NextResponse.json(
      {
        configured: config.licenseKey !== null,
        source: config.source,
        admin,
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

export async function GET(): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile) {
    return NextResponse.json(
      { error: "Not signed in." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return response(isAdmin(profile));
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
  const body = schema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json(
      { error: "Enter a valid tldraw license key." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (
    profile.passwordHash &&
    !(await verifyProfilePassword(profile, body.data.password ?? ""))
  ) {
    return NextResponse.json(
      { error: "Your profile password is required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    setCanvasLicenseKey(body.data.licenseKey);
    return response(true);
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
