import path from "node:path";
import {
  CredentialCodec,
  CredentialValidationError,
} from "thesidedoor-core/configuration";
import { localEncryptionKey } from "thesidedoor-core/storage";
import { providerDescriptors } from "thesidedoor-core/ai/catalog";
import { providerConnection } from "thesidedoor-core/ai/connection";
import {
  applyAgentSelection,
  AI_CREDENTIALS_READY,
  type AiState,
  type AgentSelectionUpdate,
} from "../state";

function descriptorFor(provider: string) {
  const descriptor = providerDescriptors().find(
    (entry) => entry.id === provider,
  );
  if (!descriptor) throw new Error("Unknown AI provider");
  return descriptor;
}

export function normalizeProviderEndpoint(
  provider: string,
  baseUrl: string,
): string {
  const descriptor = descriptorFor(provider);
  return providerConnection(
    { baseUrl },
    {
      defaultBaseUrl: baseUrl,
      normalizeV1: provider === "openai" || descriptor.transport === "local",
      requiresKey: false,
    },
  ).baseUrl;
}

export function applyAiConfiguration(
  state: AiState,
  update: AgentSelectionUpdate,
  directory: string,
  credentials?: Record<string, string | number | boolean | null>,
  resetCredentials = false,
): void {
  if (!state.imports.includes(AI_CREDENTIALS_READY))
    throw new Error(
      "Run the local access migration before changing provider credentials.",
    );
  const endpointPatch = credentials?.baseUrl;
  if (
    endpointPatch !== undefined &&
    endpointPatch !== null &&
    typeof endpointPatch !== "string"
  )
    throw new CredentialValidationError("Invalid credential field: baseUrl");
  if (
    endpointPatch !== undefined &&
    update.baseUrl !== undefined &&
    endpointPatch !== update.baseUrl
  )
    throw new CredentialValidationError("Conflicting AI endpoint settings");
  const selectionUpdate =
    endpointPatch === undefined
      ? update
      : { ...update, baseUrl: endpointPatch };
  const selection = applyAgentSelection(state.selection, selectionUpdate);
  const previousProvider = state.selection.provider;
  if (
    update.provider !== undefined &&
    previousProvider &&
    previousProvider !== selection.provider &&
    descriptorFor(previousProvider).fields.some(
      (field) => field.id === "baseUrl",
    )
  ) {
    credentialCodec(state, directory, true).configureState(
      state.credentials,
      previousProvider,
      { baseUrl: null },
    );
  }
  const provider = selection.provider;
  if (resetCredentials) {
    if (!provider)
      throw new Error("Select an AI provider before removing credentials");
    credentialCodec(state, directory, true).removeState(
      state.credentials,
      provider,
    );
    if (selectionUpdate.baseUrl === undefined) delete selection.baseUrl;
  }
  if (
    provider &&
    (update.provider !== undefined ||
      update.baseUrl !== undefined ||
      credentials)
  ) {
    const descriptor = descriptorFor(provider);
    const patch = { ...credentials };
    if (
      descriptor.fields.some((field) => field.id === "baseUrl") &&
      (selectionUpdate.provider !== undefined ||
        selectionUpdate.baseUrl !== undefined)
    ) {
      patch.baseUrl = selection.baseUrl
        ? normalizeProviderEndpoint(provider, selection.baseUrl)
        : null;
      if (
        selection.baseUrl &&
        !credentials &&
        descriptor.fields.some((field) => field.id === "allowAnonymous")
      )
        patch.allowAnonymous = true;
      if (selection.baseUrl)
        selection.provider = provider as NonNullable<typeof selection.provider>;
    }
    if (Object.keys(patch).length)
      credentialCodec(state, directory, true).configureState(
        state.credentials,
        provider,
        patch,
      );
  } else if (credentials && Object.keys(credentials).length) {
    throw new Error("Select an AI provider before configuring credentials");
  }
  state.selection = selection;
  state.revision++;
}

/** A writing codec is scoped to the current authoritative identity transaction. */
export function credentialCodec(
  state: AiState,
  directory: string,
  writing = false,
): CredentialCodec {
  return new CredentialCodec({
    namespace: "papernook:provider-credentials",
    descriptors: providerDescriptors,
    encryptionKey: () =>
      localEncryptionKey(path.join(directory, "provider-credentials.key"), {
        create:
          writing &&
          !state.credentials.providers.some((record) => record.encrypted),
      }),
  });
}
