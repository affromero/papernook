import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { activeProfile } from "@/lib/auth/session";
import { gatePassed } from "@/lib/auth/gate";
import { requestIsPublic } from "@/lib/auth/exposure";

/**
 * Serve the signed importable Shortcut to people who belong here: anyone on
 * a private path, and gate-passed or logged-in visitors on the public one.
 * The file itself holds no secrets (server and token are import questions),
 * but there is no reason to hand it to strangers.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (
    (await requestIsPublic()) &&
    !(await activeProfile()) &&
    !(await gatePassed())
  ) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const file = path.join(process.cwd(), "assets", "add-to-papernook.shortcut");
  const bytes = fs.readFileSync(file);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="Add to papernook.shortcut"',
      "cache-control": "no-cache",
    },
  });
}
