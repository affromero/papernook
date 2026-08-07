import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";
import { CaptureError, downloadPdf } from "@/lib/capture/download";

export const dynamic = "force-dynamic";

/**
 * Same-origin proxy for the /viewer page: the CSP's connect-src 'self'
 * (deliberately) blocks the browser from fetching external PDFs, so the
 * server fetches through downloadPdf's SSRF guards and size caps instead.
 */

const srcSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "http(s) URLs only");

export async function GET(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const src = srcSchema.safeParse(request.nextUrl.searchParams.get("src"));
  if (!src.success) {
    return NextResponse.json({ error: "Invalid PDF URL." }, { status: 400 });
  }
  // Every load re-fetches the origin (PdfReader fetches with no-store), so
  // keep the window tight enough that a stuck reload loop cannot hammer it.
  const wait = consumeRequestLimit(
    `viewer-pdf:${profile.username}`,
    30,
    10 * 60_000,
  );
  if (wait > 0) {
    return NextResponse.json(
      { error: "Too many PDF loads. Try again shortly." },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil(wait / 1000)) },
      },
    );
  }
  try {
    const pdf = await downloadPdf(src.data);
    return new NextResponse(new Uint8Array(pdf.bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": "inline",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof CaptureError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
