import { spawn } from "node:child_process";
import {
  buildAgentInvocation,
  getClaudeSshHost,
  getCodexSshHost,
} from "./invocation";
import { claudeCodeProvider } from "./claude-code";
import { codexProvider } from "./codex";
import { anthropicProvider, openaiProvider } from "./api";
import type { AgentProvider, ProviderId } from "./types";

/**
 * Provider registry. The active provider is chosen at install/wizard time via
 * AI_PROVIDER (never hardcoded; Sotto's install.sh pattern):
 *   anthropic | openai      API key in env
 *   claude-code | codex     local CLI (keyless), or over SSH via
 *                           CLAUDE_CODE_SSH_HOST / CODEX_SSH_HOST
 */

const PROVIDERS: Record<ProviderId, AgentProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  "claude-code": claudeCodeProvider,
  codex: codexProvider,
};

export function providerIds(): ProviderId[] {
  return Object.keys(PROVIDERS) as ProviderId[];
}

export function configuredProviderId(): ProviderId {
  const id = process.env.AI_PROVIDER;
  if (id && id in PROVIDERS) return id as ProviderId;
  throw new Error(
    `AI_PROVIDER must be one of ${providerIds().join(", ")}: got ${JSON.stringify(id ?? null)}. Run the setup wizard.`,
  );
}

export function getProvider(id?: ProviderId): AgentProvider {
  return PROVIDERS[id ?? configuredProviderId()];
}

/**
 * Lightweight availability probe, ported from Sotto's agent-availability.ts:
 * `<cli> --version` locally or over SSH, short timeout, no full execution.
 */
function cliResponds(cli: string, sshHost?: string): Promise<boolean> {
  const { command, args } = buildAgentInvocation(cli, ["--version"], sshHost);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(false);
    }, 10_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function isProviderAvailable(id: ProviderId): Promise<boolean> {
  switch (id) {
    case "anthropic":
      return Boolean(process.env.ANTHROPIC_API_KEY);
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "claude-code":
      return cliResponds("claude", getClaudeSshHost());
    case "codex":
      return cliResponds("codex", getCodexSshHost());
  }
}
