import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { modelSuggestions } from "./config";
import type { ProviderId } from "./types";

/**
 * The models a provider currently offers. Live where an API can be asked
 * (Anthropic and OpenAI list endpoints; claude-code also goes live when an
 * ANTHROPIC_API_KEY happens to be present, since the CLI serves the same
 * models). CLIs without a key fall back to the curated suggestions.
 * Results cache for 10 minutes; failures fall back to curated.
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

async function openaiModels(): Promise<string[]> {
  const client = new OpenAI();
  const models: string[] = [];
  for await (const model of client.models.list()) {
    if (/^(gpt|o\d)/.test(model.id)) models.push(model.id);
  }
  return models.sort().reverse();
}

export async function listOfferedModels(
  provider: ProviderId,
): Promise<{ models: string[]; live: boolean }> {
  const cached = cache.get(provider);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return { models: cached.models, live: true };
  }
  try {
    let models: string[] | null = null;
    if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
      models = await anthropicModels();
    } else if (provider === "claude-code" && process.env.ANTHROPIC_API_KEY) {
      // The CLI serves the same catalog; aliases stay usable too.
      models = [...modelSuggestions(provider), ...(await anthropicModels())];
    } else if (provider === "openai" && process.env.OPENAI_API_KEY) {
      models = await openaiModels();
    }
    if (models && models.length > 0) {
      cache.set(provider, { at: Date.now(), models });
      return { models, live: true };
    }
  } catch {
    // fall through to curated
  }
  return { models: modelSuggestions(provider), live: false };
}
