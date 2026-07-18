/**
 * Provider-agnostic agent interface. Every provider accepts the same turn
 * shape: API-key (anthropic, openai), local CLI (claude-code, codex), or the
 * same CLIs over SSH. `images` are LOCAL file paths; each provider's
 * attachment routing decides how they travel (base64 for APIs, path
 * references for local CLIs, scp for SSH; see attachments.ts).
 */

export type ProviderId = "anthropic" | "openai" | "claude-code" | "codex";

export interface AgentTurn {
  system: string;
  prompt: string;
  /** Absolute local paths to images (crops, pasted screenshots). */
  images?: string[];
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
