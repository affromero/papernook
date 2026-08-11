import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "../data-dir";
import type { ProviderId } from "./types";

/**
 * Runtime agent configuration the admin edits from Settings, stored at
 * data/agent-config.json (filesystem truth) — the single source for model
 * and capability choices; install.sh seeds it and Settings edits it. Suggestions are a convenience list, not a restriction; any model
 * string the provider accepts is valid.
 */

interface AgentConfig {
  provider?: ProviderId;
  model?: string;
  effort?: AgentEffort;
  baseUrl?: string;
  /** Admin override; web-capable providers default to allowing web search. */
  webAccess?: boolean;
}

export const AGENT_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export function isAgentEffort(value: unknown): value is AgentEffort {
  return AGENT_EFFORTS.includes(value as AgentEffort);
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
  effort?: AgentEffort | null;
  baseUrl?: string | null;
  webAccess?: boolean | null;
}): void {
  const config = readAgentConfig();
  if (update.provider !== undefined) {
    if (update.provider) config.provider = update.provider;
    else delete config.provider;
    delete config.model;
    delete config.effort;
    delete config.baseUrl;
  }
  if (update.model !== undefined) {
    delete config.effort;
    if (update.model) config.model = update.model;
    else delete config.model;
  }
  if (update.effort !== undefined) {
    if (update.effort) config.effort = update.effort;
    else delete config.effort;
  }
  if (update.baseUrl !== undefined) {
    if (update.baseUrl) config.baseUrl = update.baseUrl;
    else delete config.baseUrl;
  }
  if (update.webAccess === null) {
    delete config.webAccess;
  } else if (update.webAccess !== undefined) {
    config.webAccess = update.webAccess;
  }
  writeConfig(config);
}

/** Web-capable turns are enabled unless an admin explicitly opts out. */
export function webAccessEnabled(): boolean {
  return readAgentConfig().webAccess !== false;
}

export function setAgentProvider(provider: ProviderId | null): void {
  updateAgentConfig({ provider });
}

/** Admin-selected provider, before the AI_PROVIDER env fallback. */
export function configuredProviderOverride(): ProviderId | undefined {
  return readAgentConfig().provider;
}

/**
 * The model to use, or undefined for the provider's own default. Settings
 * (agent-config.json) is the single source — install.sh seeds the same file,
 * and there are no per-provider env fallbacks.
 */
export function configuredModel(): string | undefined {
  return readAgentConfig().model || undefined;
}

/** Explicit thinking effort, or undefined for the model/provider default. */
export function configuredEffort(): AgentEffort | undefined {
  return readAgentConfig().effort || undefined;
}

/** Curated fallback when a CLI cannot report model-specific effort levels. */
export function effortSuggestions(provider: ProviderId): AgentEffort[] {
  if (provider === "codex") return [...AGENT_EFFORTS];
  if (provider === "claude-code") {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  return [];
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
      // Per `claude --help`, these aliases track the latest release in each
      // tier. Exact model ids remain available through the custom model field.
      return ["fable", "opus", "sonnet", "haiku"];
    case "codex":
      return ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
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
