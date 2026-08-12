import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { activeProfile } from "@/lib/auth/session";
import { isPublicExposure } from "@/lib/data-dir";
import { isAdmin, verifyProfilePassword } from "@/lib/auth/users";
import { readBoundedJsonOrNull } from "@/lib/bounded-request";
import {
  AGENT_EFFORTS,
  configuredBaseUrl,
  configuredEffort,
  configuredModel,
  effortSuggestions,
  modelSuggestions,
  storedBaseUrl,
  updateAgentConfig,
  webAccessEnabled,
} from "@/lib/agent/config";
import { listOfferedModels, resetModelCache } from "@/lib/agent/models";
import {
  configuredProviderId,
  allProviderStatuses,
  getProvider,
  resetProviderStatusCache,
} from "@/lib/agent/registry";
import {
  PROVIDER_IDS,
  isLocalProvider,
  type ProviderId,
} from "@/lib/agent/types";
import { credentialReloadAvailable } from "@/lib/agent/credentials";

/**
 * Admin agent controls: which provider answers and with which model.
 * GET returns configuration immediately. `?probe=1` additionally performs
 * slower provider readiness and live-model discovery for background refreshes.
 */

export const dynamic = "force-dynamic";

async function snapshot(admin: boolean, probe: boolean) {
  let provider: ProviderId | null = null;
  try {
    provider = configuredProviderId();
  } catch {
    provider = null;
  }
  const [offered, statuses] = await Promise.all([
    provider
      ? probe
        ? listOfferedModels(provider)
        : Promise.resolve({
            models: modelSuggestions(provider),
            live: false,
            effortOptions: effortSuggestions(provider),
            defaultEffort: null,
          })
      : Promise.resolve({
          models: [],
          live: false,
          effortOptions: [],
          defaultEffort: null,
        }),
    probe
      ? allProviderStatuses()
      : Promise.resolve(
          Object.fromEntries(
            PROVIDER_IDS.map((id) => [id, "checking"] as const),
          ),
        ),
  ]);
  return {
    provider,
    statuses,
    model: provider ? (configuredModel() ?? null) : null,
    effort: provider ? (configuredEffort() ?? null) : null,
    effortOptions: offered.effortOptions ?? [],
    defaultEffort: offered.defaultEffort ?? null,
    baseUrl: admin && provider ? (storedBaseUrl(provider) ?? null) : null,
    baseUrlPlaceholder:
      admin && provider ? (configuredBaseUrl(provider) ?? null) : null,
    endpointConfigurable:
      admin && provider
        ? provider === "openai" || isLocalProvider(provider)
        : false,
    suggestions: offered.models,
    liveList: offered.live,
    available: probe && provider ? statuses[provider] === "ready" : undefined,
    admin,
    publicExposure: isPublicExposure(),
    webAccess: webAccessEnabled(),
    webCapable: provider ? getProvider(provider).capabilities.web : false,
    credentialReloadAvailable: provider
      ? credentialReloadAvailable(provider)
      : false,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const probe = request.nextUrl.searchParams.get("probe") === "1";
  return NextResponse.json(await snapshot(isAdmin(me), probe));
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
  effort: z.enum(AGENT_EFFORTS).nullable().optional(),
  baseUrl: baseUrlSchema.nullable().optional(),
  webAccess: z.boolean().optional(),
  password: z.string().max(200).optional(),
});

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const me = await activeProfile();
  if (!me)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!isAdmin(me)) {
    return NextResponse.json({ error: "Admin only." }, { status: 403 });
  }
  const body = schema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid selection." }, { status: 400 });
  }
  if (
    me.passwordHash &&
    !(await verifyProfilePassword(me, body.data.password ?? ""))
  ) {
    return NextResponse.json(
      { error: "Your profile password is required." },
      { status: 401 },
    );
  }
  const targetProvider = body.data.provider ?? configuredProviderId();
  if (
    body.data.effort != null &&
    targetProvider !== "codex" &&
    targetProvider !== "claude-code"
  ) {
    return NextResponse.json(
      { error: "Thinking effort is only supported by CLI providers." },
      { status: 400 },
    );
  }
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
  if (
    body.data.webAccess === true &&
    !getProvider(targetProvider).capabilities.web
  ) {
    return NextResponse.json(
      { error: "This provider has no web search." },
      { status: 400 },
    );
  }
  updateAgentConfig({
    provider: body.data.provider,
    model:
      body.data.model === undefined
        ? undefined
        : body.data.model?.trim() || null,
    effort: body.data.effort,
    baseUrl:
      body.data.baseUrl === undefined
        ? undefined
        : body.data.baseUrl?.trim() || null,
    webAccess: body.data.webAccess,
  });
  resetProviderStatusCache();
  resetModelCache();
  return NextResponse.json(await snapshot(true, false));
}
