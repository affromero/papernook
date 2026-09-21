import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  sharedAccess,
  requestIdentity,
  accessFailure,
} from "@/lib/auth/access";
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
  readAiState,
  webAccessEnabled,
} from "@/lib/agent/config";
import { listOfferedModels, resetModelCache } from "@/lib/agent/models";
import {
  configuredProviderId,
  allProviderStatuses,
  getProvider,
  resetProviderStatusCache,
} from "@/lib/agent/registry";
import { PROVIDER_IDS, type ProviderId } from "@/lib/agent/types";
import { credentialReloadAvailable } from "@/lib/agent/credentials";
import { providerDescriptors } from "thesidedoor-core/ai/catalog";
import { credentialCodec } from "@/lib/agent/platform/vault";
import { dataRoot } from "@/lib/data-dir";
import { CredentialValidationError } from "thesidedoor-core/configuration";

/**
 * Admin agent controls: which provider answers and with which model.
 * GET returns configuration immediately. `?probe=1` additionally performs
 * slower provider readiness and live-model discovery for background refreshes.
 */

export const dynamic = "force-dynamic";

function staticOffering(provider: ProviderId | null) {
  return {
    models: provider ? modelSuggestions(provider) : [],
    live: false,
    effortOptions: provider ? effortSuggestions(provider) : [],
    defaultEffort: null,
  };
}

async function snapshot(token: string, probe: boolean) {
  const initial = readAiState();
  let provider: ProviderId | null = null;
  try {
    provider = configuredProviderId(initial.selection);
  } catch {
    provider = null;
  }
  const [discovered, probedStatuses] = await Promise.all([
    provider
      ? probe
        ? listOfferedModels(provider, initial)
        : Promise.resolve(staticOffering(provider))
      : Promise.resolve(staticOffering(null)),
    probe
      ? allProviderStatuses(initial)
      : Promise.resolve(
          Object.fromEntries(
            PROVIDER_IDS.map((id) => [id, "checking"] as const),
          ),
        ),
  ]);
  const { identity, access } = sharedAccess();
  const latest = identity.readSnapshot();
  const authenticated = access.sessionFromState(latest.access, token);
  const admin = authenticated.principal?.role === "owner";
  const changed = latest.ai.revision !== initial.revision;
  const config = latest.ai.selection;
  if (changed) {
    try {
      provider = configuredProviderId(config);
    } catch {
      provider = null;
    }
  }
  const offered = changed ? staticOffering(provider) : discovered;
  const statuses = changed
    ? Object.fromEntries(PROVIDER_IDS.map((id) => [id, "checking"] as const))
    : probedStatuses;
  const descriptor =
    admin && provider
      ? providerDescriptors().find((entry) => entry.id === provider)
      : undefined;
  let credentialFields;
  let credentialError = false;
  if (descriptor) {
    try {
      credentialFields = credentialCodec(latest.ai, dataRoot()).describeState(
        latest.ai.credentials,
        descriptor.id,
      ).fields;
    } catch {
      credentialError = true;
    }
  }
  return {
    ...(admin ? { descriptor, credentialFields, credentialError } : {}),
    revision: latest.ai.revision,
    provider,
    statuses,
    model: provider ? (configuredModel(config) ?? null) : null,
    effort: provider ? (configuredEffort(config) ?? null) : null,
    effortOptions: offered.effortOptions ?? [],
    defaultEffort: offered.defaultEffort ?? null,
    baseUrl:
      admin && provider ? (storedBaseUrl(provider, config) ?? null) : null,
    baseUrlPlaceholder:
      admin && provider ? (configuredBaseUrl(provider, config) ?? null) : null,
    endpointConfigurable:
      admin && provider
        ? descriptor?.fields.some((field) => field.id === "baseUrl") === true
        : false,
    suggestions: offered.models,
    liveList: offered.live,
    discoveryError: changed
      ? "AI settings changed during discovery. Check models again."
      : "discoveryError" in offered
        ? offered.discoveryError
        : null,
    available:
      probe && provider && !changed
        ? statuses[provider] === "ready"
        : undefined,
    admin,
    webAccess: webAccessEnabled(config),
    webCapable: provider ? getProvider(provider).capabilities.web : false,
    credentialReloadAvailable: provider
      ? credentialReloadAvailable(provider)
      : false,
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  const admission = await requestIdentity();
  if (!admission?.capability)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const probe = request.nextUrl.searchParams.get("probe") === "1";
  try {
    return NextResponse.json(await snapshot(admission.token, probe));
  } catch (error) {
    return accessFailure(error);
  }
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
  credentials: z
    .record(
      z.string().max(100),
      z.union([
        z.string().max(16384),
        z.number().finite(),
        z.boolean(),
        z.null(),
      ]),
    )
    .optional(),
  resetCredentials: z.boolean().optional(),
  revision: z.number().int().nonnegative().optional(),
  provider: z.enum(PROVIDER_IDS).optional(),
  model: z.string().max(200).nullable().optional(),
  effort: z.enum(AGENT_EFFORTS).nullable().optional(),
  baseUrl: baseUrlSchema.nullable().optional(),
  webAccess: z.boolean().optional(),
});

export async function PUT(request: NextRequest): Promise<Response> {
  const admission = await requestIdentity();
  if (!admission?.capability)
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (admission.principal?.role !== "owner") {
    return NextResponse.json({ error: "Admin only." }, { status: 403 });
  }
  const revision = readAiState().revision;
  const body = schema.safeParse(await readBoundedJsonOrNull(request));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid selection." }, { status: 400 });
  }
  let targetProvider: ProviderId;
  try {
    targetProvider = body.data.provider ?? configuredProviderId();
  } catch {
    return NextResponse.json(
      { error: "Select an AI provider before saving settings." },
      { status: 400 },
    );
  }
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
    !providerDescriptors()
      .find((entry) => entry.id === targetProvider)
      ?.fields.some((field) => field.id === "baseUrl")
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
  try {
    await updateAgentConfig(
      {
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
      },
      {
        token: admission.token,
        expectedRevision: body.data.revision ?? revision,
      },
      body.data.credentials,
      body.data.resetCredentials,
    );
  } catch (error) {
    if (error instanceof CredentialValidationError)
      return NextResponse.json({ error: error.message }, { status: 400 });
    return accessFailure(error);
  }
  resetProviderStatusCache();
  resetModelCache();
  try {
    return NextResponse.json(await snapshot(admission.token, false));
  } catch (error) {
    return accessFailure(error);
  }
}
