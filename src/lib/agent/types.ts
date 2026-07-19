/**
 * Provider-agnostic agent interface. Every provider accepts the same turn
 * shape: API-key (anthropic, openai), local CLI (claude-code, codex), or the
 * same CLIs over SSH. `images` are LOCAL file paths; each provider's
 * attachment routing decides how they travel (base64 for APIs, path
 * references for local CLIs, scp for SSH; see attachments.ts).
 */

export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "claude-code",
  "codex",
  "ollama",
  "llamacpp",
  "vllm",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const LOCAL_PROVIDER_IDS = ["ollama", "llamacpp", "vllm"] as const;

export type LocalProviderId = (typeof LOCAL_PROVIDER_IDS)[number];

export function isLocalProvider(
  provider: ProviderId,
): provider is LocalProviderId {
  return (LOCAL_PROVIDER_IDS as readonly ProviderId[]).includes(provider);
}

export interface AgentTurn {
  system: string;
  prompt: string;
  /** Absolute local paths to images (crops, pasted screenshots). */
  images?: string[];
  /** Ask compatible APIs to constrain the response to a JSON object. */
  responseFormat?: "json_object";
  timeoutMs?: number;
}

export interface AgentProvider {
  id: ProviderId;
  /** Run one turn and return the full text response. */
  execute(turn: AgentTurn): Promise<string>;
  /** Run one turn, yielding text chunks as they arrive. */
  stream(turn: AgentTurn): AsyncGenerator<string>;
}

export const DEFAULT_TIMEOUT_MS = 600_000;
