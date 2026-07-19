import { configuredBaseUrl } from "./config";
import type { LocalProviderId, ProviderId } from "./types";

export function ensureV1Suffix(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
}

export function compatibleBaseUrl(provider: ProviderId): string | undefined {
  const configured = configuredBaseUrl(provider);
  if (!configured) return undefined;
  return ensureV1Suffix(configured);
}

export function localModelsUrl(provider: LocalProviderId): string {
  const baseUrl = configuredBaseUrl(provider);
  if (!baseUrl) {
    throw new Error(`${provider}: no endpoint configured`);
  }
  const host = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return provider === "ollama" ? `${host}/api/tags` : `${host}/v1/models`;
}

export async function localProviderResponds(
  provider: LocalProviderId,
): Promise<boolean> {
  try {
    const response = await fetch(localModelsUrl(provider), {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
