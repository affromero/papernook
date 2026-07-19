import { spawn } from "node:child_process";
import {
  buildAgentInvocation,
  getClaudeSshHost,
  getCodexSshHost,
} from "./invocation";
import { claudeCodeProvider } from "./claude-code";
import { codexProvider } from "./codex";
import {
  anthropicProvider,
  llamacppProvider,
  ollamaProvider,
  openaiProvider,
  vllmProvider,
} from "./api";
import {
  configuredBaseUrl,
  configuredModel,
  configuredProviderOverride,
} from "./config";
import { compatibleBaseUrl, localProviderResponds } from "./local";
import {
  PROVIDER_IDS,
  isLocalProvider,
  type AgentProvider,
  type ProviderId,
} from "./types";
/**
 * Provider registry. The active provider is chosen at install/wizard time via
 * AI_PROVIDER (never hardcoded; Sotto's install.sh pattern):
 *   anthropic | openai      API key in env
 *   claude-code | codex     local CLI (keyless), or over SSH via
 *                           CLAUDE_CODE_SSH_HOST / CODEX_SSH_HOST
 *   ollama | llamacpp | vllm OpenAI-compatible local model servers
 */

const PROVIDERS: Record<ProviderId, AgentProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  "claude-code": claudeCodeProvider,
  codex: codexProvider,
  ollama: ollamaProvider,
  llamacpp: llamacppProvider,
  vllm: vllmProvider,
};

export function providerIds(): ProviderId[] {
  return [...PROVIDER_IDS];
}

export function configuredProviderId(): ProviderId {
  const override = configuredProviderOverride();
  if (override && override in PROVIDERS) return override;
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
 * Lightweight CLI probe locally or over SSH, with a short timeout.
 */
function cliResponds(
  cli: string,
  cliArgs: string[],
  sshHost?: string,
): Promise<boolean> {
  const { command, args } = buildAgentInvocation(cli, cliArgs, sshHost);
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
  return (await providerStatus(id)) === "ready";
}

/**
 * Discover a ready keyless CLI when the admin has not selected a provider.
 * Codex is preferred when both CLIs answer; explicit configuration always
 * remains authoritative through `configuredProviderId`.
 */
export async function detectLocalCliProvider(): Promise<
  "codex" | "claude-code" | null
> {
  const [codex, claude] = await Promise.all([
    providerStatus("codex"),
    providerStatus("claude-code"),
  ]);
  if (codex === "ready") return "codex";
  if (claude === "ready") return "claude-code";
  return null;
}

/**
 * flight-finder-style readiness per provider:
 *   ready          answers now
 *   no_key         API provider without its key
 *   no_model       local endpoint is ready but no model is selected
 *   not_installed  local CLI missing
 *   not_authenticated local CLI exists but has no usable login
 *   unreachable    CLI configured over SSH but not answering
 */
export type ProviderReadiness =
  | "ready"
  | "no_key"
  | "no_model"
  | "not_installed"
  | "not_authenticated"
  | "unreachable";

export async function providerStatus(
  id: ProviderId,
): Promise<ProviderReadiness> {
  if (isLocalProvider(id)) {
    if (!(await localProviderResponds(id))) return "unreachable";
    return configuredModel(id) ? "ready" : "no_model";
  }
  switch (id) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ? "ready" : "no_key";
    case "openai":
      if (configuredBaseUrl("openai")) {
        try {
          const response = await fetch(
            `${compatibleBaseUrl("openai")}/models`,
            { signal: AbortSignal.timeout(3_000) },
          );
          return response.ok ? "ready" : "unreachable";
        } catch {
          return "unreachable";
        }
      }
      return process.env.OPENAI_API_KEY ? "ready" : "no_key";
    case "claude-code": {
      const ssh = getClaudeSshHost();
      if (!(await cliResponds("claude", ["--version"], ssh))) {
        return ssh ? "unreachable" : "not_installed";
      }
      return (await cliResponds("claude", ["auth", "status"], ssh))
        ? "ready"
        : "not_authenticated";
    }
    case "codex": {
      const ssh = getCodexSshHost();
      if (!(await cliResponds("codex", ["--version"], ssh))) {
        return ssh ? "unreachable" : "not_installed";
      }
      return (await cliResponds("codex", ["login", "status"], ssh))
        ? "ready"
        : "not_authenticated";
    }
  }
}

let statusCache: {
  at: number;
  statuses: Record<ProviderId, ProviderReadiness>;
} | null = null;

/** Statuses for every provider, probed in parallel, cached for 60s. */
export async function allProviderStatuses(): Promise<
  Record<ProviderId, ProviderReadiness>
> {
  if (statusCache && Date.now() - statusCache.at < 60_000) {
    return statusCache.statuses;
  }
  const ids = providerIds();
  const results = await Promise.all(ids.map((id) => providerStatus(id)));
  const statuses = Object.fromEntries(
    ids.map((id, i) => [id, results[i]]),
  ) as Record<ProviderId, ProviderReadiness>;
  statusCache = { at: Date.now(), statuses };
  return statuses;
}

/** Test hook / post-save refresh: drop the cached statuses. */
export function resetProviderStatusCache(): void {
  statusCache = null;
}
