import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import {
  acceptInboxCapture,
  CaptureOwnershipError,
  discardInboxCapture,
} from "@/lib/library/papers";
import { rebuildIndex } from "@/lib/library/index-db";
import { isValidSlug } from "@/lib/library/slug";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ slug: string }>;
}

const slugSchema = z.string().refine(isValidSlug);
const acceptSchema = z.object({ topic: slugSchema }).strict();

export async function PATCH(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsedParams = slugSchema.safeParse((await params).slug);
  const body = acceptSchema.safeParse(await request.json().catch(() => null));
  if (!parsedParams.success || !body.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    const paper = acceptInboxCapture(
      parsedParams.data,
      body.data.topic,
      profile.username,
    );
    rebuildIndex();
    return NextResponse.json({
      href: `/paper/${paper.topic}/${paper.slug}`,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof CaptureOwnershipError
            ? "This pending paper is no longer available."
            : error instanceof Error
              ? error.message
              : "The paper could not be filed.",
      },
      { status: error instanceof CaptureOwnershipError ? 404 : 500 },
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const parsedParams = slugSchema.safeParse((await params).slug);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  try {
    discardInboxCapture(parsedParams.data, profile.username);
    rebuildIndex();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof CaptureOwnershipError
            ? "This pending paper is no longer available."
            : "The paper could not be discarded.",
      },
      { status: error instanceof CaptureOwnershipError ? 404 : 500 },
    );
  }
}
