import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { consumeRequestLimit } from "@/lib/auth/rate-limit";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import { captureAsync } from "@/lib/capture";
import { CaptureError } from "@/lib/capture/download";

export const dynamic = "force-dynamic";

/**
 * Session-authed capture for the in-app /viewer "Add to papernook" button.
 * Same orchestration as the token-authed /add endpoint; the capture()
 * re-download keeps dedupe and inbox handling in one place (it also waits
 * out downloadPdf's per-host cooldown left by the viewer proxy fetch —
 * intentional politeness, not a bug).
 */

const bodySchema = z.object({ url: z.string().url() }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = bodySchema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid URL." }, { status: 400 });
  }
  const wait = consumeRequestLimit(
    `capture-profile:${profile.username}`,
    20,
    60 * 60_000,
  );
  if (wait > 0) {
    return NextResponse.json(
      { error: "Too many captures. Try again later." },
      {
        status: 429,
        headers: { "retry-after": String(Math.ceil(wait / 1000)) },
      },
    );
  }
  try {
    // Async: the marker on disk carries the outcome (Cloudflare cuts
    // responses at 100s, so waiting inline loses it). Failures — including
    // duplicates — surface as job cards in the inbox view.
    const result = captureAsync(body.data.url, profile.username);
    return NextResponse.json(
      { slug: result.slug, href: "/?topic=_inbox" },
      { status: 202 },
    );
  } catch (error) {
    // Synchronous failures only: profile mid-erasure, disk errors.
    console.error(`papernook capture failed (${body.data.url}):`, error);
    if (error instanceof CaptureError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    const message =
      error instanceof Error ? error.message : "Capture failed on the server.";
    return NextResponse.json(
      { error: `Capture failed: ${message}` },
      { status: 502 },
    );
  }
}
