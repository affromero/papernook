import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/users";
import {
  configuredModel,
  setAgentModel,
  setAgentProvider,
} from "@/lib/agent/config";
import { listOfferedModels } from "@/lib/agent/models";
import {
  configuredProviderId,
  isProviderAvailable,
  allProviderStatuses,
  resetProviderStatusCache,
} from "@/lib/agent/registry";
import type { ProviderId } from "@/lib/agent/types";

/**
 * Admin agent controls: which provider answers and with which model.
 * GET returns the current selection plus the models the provider offers
 * right now (live from its API when reachable, curated otherwise).
 */

export const dynamic = "force-dynamic";

async function snapshot(admin: boolean) {
  let provider: ProviderId | null = null;
  try {
    provider = configuredProviderId();
  } catch {
    provider = null;
  }
  const [offered, statuses] = await Promise.all([
    provider
      ? listOfferedModels(provider)
      : Promise.resolve({ models: [], live: false }),
    allProviderStatuses(),
  ]);
  return {
    provider,
    statuses,
    model: provider ? (configuredModel(provider) ?? null) : null,
    suggestions: offered.models,
    liveList: offered.live,
    admin,
  };
}

export async function GET(): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  return NextResponse.json(await snapshot(isAdmin(me)));
}

const schema = z.object({
  provider: z.enum(["anthropic", "openai", "claude-code", "codex"]).optional(),
  model: z.string().max(80).nullable().optional(),
});

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!isAdmin(me)) {
    return NextResponse.json({ error: "Admin only." }, { status: 403 });
  }
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid selection." }, { status: 400 });
  }
  if (body.data.provider) {
    setAgentProvider(body.data.provider);
    resetProviderStatusCache();
  }
  if (body.data.model !== undefined) {
    setAgentModel(body.data.model?.trim() || null);
  }
  const provider = configuredProviderId();
  const available = await isProviderAvailable(provider);
  return NextResponse.json({ ...(await snapshot(true)), available });
}
