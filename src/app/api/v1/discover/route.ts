import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import { requestIdentity } from "@/lib/auth/access";
import { isValidSlug } from "@/lib/library/slug";
import { discoverRelated } from "@/lib/capture/discover";
import { hasConfiguredProvider } from "@/lib/agent/registry";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  topic: z.string().refine(isValidSlug).optional(),
  slug: z.string().refine(isValidSlug).optional(),
});

export async function POST(request: NextRequest) {
  const admission = await requestIdentity();
  if (!admission?.profile || !admission.capability)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = bodySchema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid focus." }, { status: 400 });
  }
  if (!hasConfiguredProvider()) {
    return NextResponse.json(
      { error: "No AI provider configured. Connect one in Settings." },
      { status: 409 },
    );
  }
  try {
    const discovery = await discoverRelated(body.data, admission.capability);
    return NextResponse.json(discovery);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Discovery failed: ${err instanceof Error ? err.message : err}`,
      },
      { status: 502 },
    );
  }
}
