import { dataRoot } from "../data-dir";
import type { ProviderId } from "./types";
import {
  PROVIDER_METADATA,
  providerDescriptors,
  modelSuggestions as sharedModelSuggestions,
} from "thesidedoor-core/ai/catalog";
import { AccessError, AccessService } from "thesidedoor-core/access";
import { PapernookIdentityStore } from "../auth/identity-store";
import { applyAiConfiguration } from "./platform/vault";
import {
  AGENT_EFFORTS,
  AI_STATE_READY,
  AI_CREDENTIALS_READY,
  type AgentConfig,
  type AgentSelectionUpdate,
  type AgentEffort,
} from "./state";
export { AGENT_EFFORTS, type AgentEffort } from "./state";

/**
 * Runtime selection shares the identity envelope so owner authorization and
 * configuration changes commit together. Suggested models remain optional.
 */

export function isAgentEffort(value: unknown): value is AgentEffort {
  return AGENT_EFFORTS.includes(value as AgentEffort);
}

export function readAiState() {
  const state = new PapernookIdentityStore(dataRoot()).readSnapshot().ai;
  if (
    !state.imports.includes(AI_STATE_READY) ||
    !state.imports.includes(AI_CREDENTIALS_READY)
  )
    throw new Error(
      "Run the local access migration before using AI configuration.",
    );
  return state;
}

export function readAgentConfig(): AgentConfig {
  return readAiState().selection;
}

export async function updateAgentConfig(
  update: AgentSelectionUpdate,
  authorization: { token: string; expectedRevision: number },
  credentials?: Record<string, string | number | boolean | null>,
  resetCredentials = false,
): Promise<void> {
  const identity = new PapernookIdentityStore(dataRoot());
  const access = new AccessService({ store: identity.accessStore() });
  await identity.transact((state) => {
    access.sessionFromState(
      state.access,
      authorization.token,
      true,
      resetCredentials ||
        credentials !== undefined ||
        update.baseUrl !== undefined ||
        update.provider !== undefined,
    );
    if (!state.ai.imports.includes(AI_STATE_READY))
      throw new Error(
        "Run the local access migration before changing AI configuration.",
      );
    if (state.ai.revision !== authorization.expectedRevision)
      throw new AccessError(
        "conflict",
        "AI settings changed. Refresh before saving.",
      );
    applyAiConfiguration(
      state.ai,
      update,
      dataRoot(),
      credentials,
      resetCredentials,
    );
  });
}

export async function selectDetectedProvider(
  token: string,
  provider: "codex" | "claude-code",
): Promise<{ selected: boolean; revision: number }> {
  const identity = new PapernookIdentityStore(dataRoot());
  const access = new AccessService({ store: identity.accessStore() });
  return identity.transact((state) => {
    access.sessionFromState(state.access, token, true);
    if (!state.ai.imports.includes(AI_STATE_READY))
      throw new Error(
        "Run the local access migration before changing AI configuration.",
      );
    if (state.ai.selection.provider)
      return { selected: false, revision: state.ai.revision };
    applyAiConfiguration(state.ai, { provider }, dataRoot());
    return { selected: true, revision: state.ai.revision };
  });
}

/** Web-capable turns are enabled unless an admin explicitly opts out. */
export function webAccessEnabled(config = readAgentConfig()): boolean {
  return config.webAccess !== false;
}

/** Admin-selected provider from the canonical identity envelope. */
export function configuredProviderOverride(
  config = readAgentConfig(),
): ProviderId | undefined {
  return config.provider;
}

/**
 * The model to use, or undefined for the provider's own default. Settings
 * (agent-config.json) is the single source — install.sh seeds the same file,
 * and there are no per-provider env fallbacks.
 */
export function configuredModel(
  config = readAgentConfig(),
): string | undefined {
  return config.model || undefined;
}

/** Explicit thinking effort, or undefined for the model/provider default. */
export function configuredEffort(
  config = readAgentConfig(),
): AgentEffort | undefined {
  return config.effort || undefined;
}

/** Curated fallback when a CLI cannot report model-specific effort levels. */
export function effortSuggestions(provider: ProviderId): AgentEffort[] {
  if (provider === "codex") return [...AGENT_EFFORTS];
  if (provider === "claude-code") {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  return [];
}

/** The explicitly stored URL for the active provider, if one exists. */
export function storedBaseUrl(
  provider: ProviderId,
  config = readAgentConfig(),
): string | undefined {
  if (config.provider !== provider) return undefined;
  return config.baseUrl;
}

/** Display the saved endpoint or the shared provider environment/default. */
export function configuredBaseUrl(
  provider: ProviderId,
  config = readAgentConfig(),
): string | undefined {
  const stored = storedBaseUrl(provider, config);
  if (stored) return stored;
  const descriptor = providerDescriptors().find(
    (entry) => entry.id === provider,
  );
  if (!descriptor) return undefined;
  return descriptor.transport === "local"
    ? PROVIDER_METADATA[provider]?.defaultBaseUrl?.replace(/\/v1\/?$/, "")
    : undefined;
}

/** Suggested models per provider (free-text stays allowed). */
export function modelSuggestions(provider: ProviderId): string[] {
  return sharedModelSuggestions(provider, "document");
}
