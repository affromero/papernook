import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { configuredBaseUrl, modelSuggestions } from "./config";
import { compatibleBaseUrl, localModelsUrl } from "./local";
import {
  isLocalProvider,
  type LocalProviderId,
  type ProviderId,
} from "./types";

/**
 * The models a provider currently offers. Anthropic, OpenAI, and local HTTP
 * providers use live list endpoints. Claude Code intentionally offers its
 * moving aliases instead of a redundant live catalog; exact ids remain
 * available as custom input. Results cache for 10 minutes; failures fall back
 * to curated.
 */

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; models: string[] }>();

async function anthropicModels(): Promise<string[]> {
  const client = new Anthropic();
  const models: string[] = [];
  for await (const model of client.models.list()) {
    models.push(model.id);
  }
  return models;
}

async function openaiModels(
  provider: "openai" | Exclude<LocalProviderId, "ollama">,
): Promise<string[]> {
  const baseURL = compatibleBaseUrl(provider);
  const client = new OpenAI({
    apiKey:
      provider === "openai"
        ? process.env.OPENAI_API_KEY || (baseURL ? "unused" : undefined)
        : "unused",
    baseURL,
  });
  const models: string[] = [];
  for await (const model of client.models.list()) {
    if (provider !== "openai" || baseURL || /^(gpt|o\d)/.test(model.id)) {
      models.push(model.id);
    }
  }
  return models.sort().reverse();
}

async function ollamaModels(): Promise<string[]> {
  const response = await fetch(localModelsUrl("ollama"), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = (await response.json()) as {
    models?: { name?: string }[];
  };
  return (data.models ?? [])
    .map((model) => model.name)
    .filter((name): name is string => Boolean(name));
}

export function resetModelCache(): void {
  cache.clear();
}

export async function listOfferedModels(
  provider: ProviderId,
): Promise<{ models: string[]; live: boolean }> {
  if (provider === "claude-code") {
    return { models: modelSuggestions(provider), live: false };
  }

  const cacheKey = `${provider}:${configuredBaseUrl(provider) ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return { models: cached.models, live: true };
  }
  try {
    let models: string[] | null = null;
    if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
      models = await anthropicModels();
    } else if (
      provider === "openai" &&
      (process.env.OPENAI_API_KEY || configuredBaseUrl(provider))
    ) {
      models = await openaiModels(provider);
    } else if (provider === "ollama") {
      models = await ollamaModels();
    } else if (isLocalProvider(provider)) {
      models = await openaiModels(provider);
    }
    if (models && models.length > 0) {
      cache.set(cacheKey, { at: Date.now(), models });
      return { models, live: true };
    }
  } catch {
    // fall through to curated
  }
  return { models: modelSuggestions(provider), live: false };
}
