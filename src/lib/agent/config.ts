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
  const config = readAgentConfig();
  if (model) config.model = model;
  else delete config.model;
  writeConfig(config);
}

/**
 * Switching provider also clears the model: model ids are provider-specific
 * and a stale one would silently break the new provider.
 */
export function setAgentProvider(provider: ProviderId | null): void {
  const config = readAgentConfig();
  if (provider) config.provider = provider;
  else delete config.provider;
  delete config.model;
  writeConfig(config);
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
  };
  return process.env[envVar[provider]] || undefined;
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
  }
}
