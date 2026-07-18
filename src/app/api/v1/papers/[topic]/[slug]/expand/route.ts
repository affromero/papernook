import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { expandPdf, ExpandError } from "@/lib/library/expand";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ topic: string; slug: string }>;
}

const schema = z.object({ mode: z.enum(["margin", "page"]) });

export async function POST(request: NextRequest, { params }: Params) {
  const profile = await activeProfile();
  if (!profile)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { topic, slug } = await params;
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid mode." }, { status: 400 });
  }
  try {
    const result = await expandPdf(topic, slug, body.data.mode);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ExpandError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
