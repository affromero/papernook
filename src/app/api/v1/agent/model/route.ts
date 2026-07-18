import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/users";
import {
  configuredModel,
  setAgentModel,
  modelSuggestions,
} from "@/lib/agent/config";
import {
  configuredProviderId,
  isProviderAvailable,
} from "@/lib/agent/registry";

/** Admin-editable model selection for whichever provider is configured. */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  try {
    const provider = configuredProviderId();
    return NextResponse.json({
      provider,
      model: configuredModel(provider) ?? null,
      suggestions: modelSuggestions(provider),
      admin: isAdmin(me),
    });
  } catch {
    return NextResponse.json({
      provider: null,
      model: null,
      suggestions: [],
      admin: isAdmin(me),
    });
  }
}

const schema = z.object({ model: z.string().max(80).nullable() });

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!isAdmin(me)) {
    return NextResponse.json({ error: "Admin only." }, { status: 403 });
  }
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid model." }, { status: 400 });
  }
  setAgentModel(body.data.model?.trim() || null);
  // Probe with the new model recorded; CLI defaults apply when cleared.
  const provider = configuredProviderId();
  const available = await isProviderAvailable(provider);
  return NextResponse.json({
    provider,
    model: configuredModel(provider) ?? null,
    available,
  });
}
