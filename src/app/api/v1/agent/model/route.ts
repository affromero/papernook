import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/users";
import {
  configuredBaseUrl,
  configuredModel,
  storedBaseUrl,
  updateAgentConfig,
} from "@/lib/agent/config";
import { listOfferedModels, resetModelCache } from "@/lib/agent/models";
import {
  configuredProviderId,
  isProviderAvailable,
  allProviderStatuses,
  resetProviderStatusCache,
} from "@/lib/agent/registry";
import {
  PROVIDER_IDS,
  isLocalProvider,
  type ProviderId,
} from "@/lib/agent/types";

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
    baseUrl: admin && provider ? (storedBaseUrl(provider) ?? null) : null,
    baseUrlPlaceholder:
      admin && provider ? (configuredBaseUrl(provider) ?? null) : null,
    endpointConfigurable:
      admin && provider
        ? provider === "openai" || isLocalProvider(provider)
        : false,
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

const baseUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Endpoint must be an HTTP(S) URL without embedded credentials.");

const schema = z.object({
  provider: z.enum(PROVIDER_IDS).optional(),
  model: z.string().max(200).nullable().optional(),
  baseUrl: baseUrlSchema.nullable().optional(),
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
  const targetProvider = body.data.provider ?? configuredProviderId();
  if (
    body.data.baseUrl !== undefined &&
    targetProvider !== "openai" &&
    !isLocalProvider(targetProvider)
  ) {
    return NextResponse.json(
      { error: "This provider does not accept a custom endpoint." },
      { status: 400 },
    );
  }
  updateAgentConfig({
    provider: body.data.provider,
    model:
      body.data.model === undefined
        ? undefined
        : body.data.model?.trim() || null,
    baseUrl:
      body.data.baseUrl === undefined
        ? undefined
        : body.data.baseUrl?.trim() || null,
  });
  resetProviderStatusCache();
  resetModelCache();
  const provider = configuredProviderId();
  const available = await isProviderAvailable(provider);
  return NextResponse.json({ ...(await snapshot(true)), available });
}
