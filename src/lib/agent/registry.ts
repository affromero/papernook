import { spawn } from "node:child_process";
import { ProcessRunner } from "thesidedoor-core/runtime/process";
import { createHash } from "node:crypto";
import { dataRoot } from "../data-dir";
import { ProviderRegistry, type CredentialValues } from "thesidedoor-core/ai";
import type { AgentConfig, AiState } from "./state";
import {
  buildAgentInvocation,
  agentProcessRequest,
  minimalAgentEnvironment,
  getClaudeSshHost,
  getCodexSshHost,
} from "./invocation";
import { createClaudeInvocation, claudeCodeProvider } from "./claude-code";
import { codexProvider } from "./codex";
import { apiCredentials, provider as createApiProvider } from "./api";
import { apiProviders } from "thesidedoor-core/ai/providers";
import {
  configuredModel,
  configuredProviderOverride,
  readAiState,
} from "./config";
import {
  PROVIDER_IDS,
  isLocalProvider,
  type AgentProvider,
  type ProviderId,
} from "./types";
/**
 * Provider registry. The owner selects the active provider in browser setup
 * or Settings. The welcome page can select a ready CLI when none is set:
 *   anthropic | openai      API key in the canonical credential vault or env
 *   claude-code | codex     local CLI (keyless), or over SSH via
 *                           CLAUDE_CODE_SSH_HOST / CODEX_SSH_HOST
 *   ollama | llamacpp | vllm OpenAI-compatible local model servers
 */

const PROVIDERS = Object.fromEntries(
  PROVIDER_IDS.map((id) => [
    id,
    id === "claude-code"
      ? claudeCodeProvider
      : id === "codex"
        ? codexProvider
        : createApiProvider(id),
  ]),
) as Record<ProviderId, AgentProvider>;

export function providerIds(): ProviderId[] {
  return [...PROVIDER_IDS];
}

export function configuredProviderId(config?: AgentConfig): ProviderId {
  const override = configuredProviderOverride(config);
  if (override && override in PROVIDERS) return override;
  throw new Error(
    `Select one of ${providerIds().join(", ")} in the setup wizard.`,
  );
}

/**
 * True when a provider is selected. Running with no provider is a supported
 * mode: capture files papers with deterministic metadata and the chat and
 * discover surfaces disable with a clear message instead of erroring. A
 * selected-but-unusable provider (e.g. a CLI provider under public exposure)
 * still counts as configured on purpose — that misconfiguration must fail
 * loudly through getProvider(), never silently degrade into no-AI mode.
 */
export function hasConfiguredProvider(config?: AgentConfig): boolean {
  const override = configuredProviderOverride(config);
  const id = override && override in PROVIDERS ? override : undefined;
  return Boolean(id && id in PROVIDERS);
}

export function getProvider(id?: ProviderId): AgentProvider {
  const selected = id ?? configuredProviderId();
  return PROVIDERS[selected];
}

/**
 * Lightweight CLI probe locally or over SSH, with a short timeout.
 */
async function cliResponds(
  cli: "claude" | "codex",
  cliArgs: string[],
  sshHost?: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (sshHost) {
    try {
      await new ProcessRunner().execute(
        agentProcessRequest({
          cli,
          args: cliArgs,
          input: "",
          sshHost,
          environment: minimalAgentEnvironment([]),
          timeoutMs: 10_000,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
  const { command, args } = buildAgentInvocation(cli, cliArgs, sshHost);
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "ignore"],
      env,
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

export async function isProviderAvailable(
  id: ProviderId,
  state = readAiState(),
): Promise<boolean> {
  return (await providerStatus(id, state)) === "ready";
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
  state: AiState = readAiState(),
  credentials?: CredentialValues,
): Promise<ProviderReadiness> {
  const values =
    credentials ??
    (id === "codex" || id === "claude-code" ? {} : apiCredentials(id, state));
  switch (id) {
    case "claude-code": {
      const ssh = getClaudeSshHost();
      // The probe spawns the CLI too, so it needs the same isolated config
      // dir a turn gets — a probe sharing one would corrupt a concurrent
      // turn's config.
      const invocation = ssh ? null : createClaudeInvocation();
      try {
        const env = invocation?.env;
        if (!(await cliResponds("claude", ["--version"], ssh, env))) {
          return ssh ? "unreachable" : "not_installed";
        }
        return (await cliResponds("claude", ["auth", "status"], ssh, env))
          ? "ready"
          : "not_authenticated";
      } finally {
        invocation?.release();
      }
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
    default:
      return apiProviderStatus(id, values, state);
  }
}

async function apiProviderStatus(
  id: Exclude<ProviderId, "claude-code" | "codex">,
  credentials: CredentialValues,
  state: AiState,
): Promise<ProviderReadiness> {
  const registry = new ProviderRegistry({
    providers: apiProviders(),
    credentials: {
      async resolve() {
        return { ...credentials };
      },
    },
  });
  const readiness = await registry.readiness(id, AbortSignal.timeout(3_000));
  if (readiness.code === "missing_credentials") return "no_key";
  if (readiness.code === "not_authenticated") return "not_authenticated";
  if (readiness.code !== "ready") return "unreachable";
  if (isLocalProvider(id) && !configuredModel(state.selection))
    return "no_model";
  return "ready";
}

const statusCache = new Map<
  string,
  {
    at: number;
    statuses: Record<ProviderId, ProviderReadiness>;
  }
>();

/** Statuses for every provider, probed in parallel, cached for 60s. */
export async function allProviderStatuses(
  state: AiState = readAiState(),
): Promise<Record<ProviderId, ProviderReadiness>> {
  const ids = providerIds();
  const credentials = ids.map((id) =>
    id === "codex" || id === "claude-code" ? {} : apiCredentials(id, state),
  );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        credentials,
        codex: getCodexSshHost(),
        claude: getClaudeSshHost(),
      }),
    )
    .digest("hex");
  const key = `${dataRoot()}:${state.revision}:${fingerprint}`;
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.statuses;
  const results = await Promise.all(
    ids.map((id, index) => providerStatus(id, state, credentials[index])),
  );
  const statuses = Object.fromEntries(
    ids.map((id, i) => [id, results[i]]),
  ) as Record<ProviderId, ProviderReadiness>;
  if (statusCache.size > 100) statusCache.clear();
  statusCache.set(key, { at: Date.now(), statuses });
  return statuses;
}

/** Test hook / post-save refresh: drop the cached statuses. */
export function resetProviderStatusCache(): void {
  statusCache.clear();
}
