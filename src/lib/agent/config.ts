import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../data-dir";
import type { ProviderId } from "./types";

/**
 * Runtime agent configuration the admin edits from Settings, stored at
 * data/agent-config.json (filesystem truth). The model resolution order for
 * every provider is: this file → the provider's env var → the CLI/API
 * default. Suggestions are a convenience list, not a restriction; any model
 * string the provider accepts is valid.
 */

interface AgentConfig {
  provider?: ProviderId;
  model?: string;
  baseUrl?: string;
}

const FILE = () => path.join(dataRoot(), "agent-config.json");

export function readAgentConfig(): AgentConfig {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8")) as AgentConfig;
  } catch {
    return {};
  }
}

function writeConfig(config: AgentConfig): void {
  fs.mkdirSync(dataRoot(), { recursive: true });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, FILE());
}

export function setAgentModel(model: string | null): void {
  updateAgentConfig({ model });
}

/**
 * Apply an admin selection in one atomic filesystem write. Switching provider
 * clears provider-specific model and endpoint values before applying any
 * values included in the same update.
 */
export function updateAgentConfig(update: {
  provider?: ProviderId | null;
  model?: string | null;
  baseUrl?: string | null;
}): void {
  const config = readAgentConfig();
  if (update.provider !== undefined) {
    if (update.provider) config.provider = update.provider;
    else delete config.provider;
    delete config.model;
    delete config.baseUrl;
  }
  if (update.model !== undefined) {
    if (update.model) config.model = update.model;
    else delete config.model;
  }
  if (update.baseUrl !== undefined) {
    if (update.baseUrl) config.baseUrl = update.baseUrl;
    else delete config.baseUrl;
  }
  writeConfig(config);
}

export function setAgentProvider(provider: ProviderId | null): void {
  updateAgentConfig({ provider });
}

/** Admin-selected provider, before the AI_PROVIDER env fallback. */
export function configuredProviderOverride(): ProviderId | undefined {
  return readAgentConfig().provider;
}

/** The model to use for a provider, or undefined for its own default. */
export function configuredModel(provider: ProviderId): string | undefined {
  const fromFile = readAgentConfig().model;
  if (fromFile) return fromFile;
  const envVar: Record<ProviderId, string> = {
    "claude-code": "CLAUDE_CODE_MODEL",
    codex: "CODEX_MODEL",
    anthropic: "ANTHROPIC_MODEL",
    openai: "OPENAI_MODEL",
    ollama: "OLLAMA_MODEL",
    llamacpp: "LLAMACPP_MODEL",
    vllm: "VLLM_MODEL",
  };
  return process.env[envVar[provider]] || undefined;
}

const DEFAULT_BASE_URLS = {
  ollama: "http://localhost:11434",
  llamacpp: "http://localhost:8080",
  vllm: "http://localhost:8000",
} as const;

/** The explicitly stored URL for the active provider, if one exists. */
export function storedBaseUrl(provider: ProviderId): string | undefined {
  const config = readAgentConfig();
  if (config.provider !== provider) return undefined;
  return config.baseUrl;
}

/** Effective URL: admin file → provider env → local provider default. */
export function configuredBaseUrl(provider: ProviderId): string | undefined {
  const stored = storedBaseUrl(provider);
  if (stored) return stored;
  const envVar: Partial<Record<ProviderId, string>> = {
    openai: "OPENAI_BASE_URL",
    ollama: "OLLAMA_HOST",
    llamacpp: "LLAMACPP_BASE_URL",
    vllm: "VLLM_BASE_URL",
  };
  const fromEnv = envVar[provider]
    ? process.env[envVar[provider] as string]
    : undefined;
  if (fromEnv) return fromEnv;
  return provider in DEFAULT_BASE_URLS
    ? DEFAULT_BASE_URLS[provider as keyof typeof DEFAULT_BASE_URLS]
    : undefined;
}

/** Suggested models per provider (free-text stays allowed). */
export function modelSuggestions(provider: ProviderId): string[] {
  switch (provider) {
    case "claude-code":
      // Aliases first (per `claude --help`, they track the latest of each
      // tier), then the current full ids.
      return [
        "fable",
        "opus",
        "sonnet",
        "haiku",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "claude-haiku-4-5",
      ];
    case "codex":
      return ["gpt-5.5", "gpt-5.5-mini"];
    case "anthropic":
      return [
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "claude-haiku-4-5",
      ];
    case "openai":
      return ["gpt-5.5", "gpt-5.5-mini"];
    case "ollama":
      return ["qwen3:4b", "qwen3:8b", "gemma3:4b"];
    case "llamacpp":
    case "vllm":
      return [];
  }
}
