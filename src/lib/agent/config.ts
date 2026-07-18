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

export function setAgentModel(model: string | null): void {
  const config = readAgentConfig();
  if (model) config.model = model;
  else delete config.model;
  fs.mkdirSync(dataRoot(), { recursive: true });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, FILE());
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
      return ["opus", "sonnet", "haiku"];
    case "codex":
      return ["gpt-5.5", "gpt-5.5-mini"];
    case "anthropic":
      return ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"];
    case "openai":
      return ["gpt-5.5", "gpt-5.5-mini"];
  }
}
