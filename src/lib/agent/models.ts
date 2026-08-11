import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  configuredBaseUrl,
  configuredModel,
  effortSuggestions,
  isAgentEffort,
  modelSuggestions,
  type AgentEffort,
} from "./config";
import { buildAgentInvocation, getCodexSshHost } from "./invocation";
import { compatibleBaseUrl, localModelsUrl } from "./local";
import {
  isLocalProvider,
  type LocalProviderId,
  type ProviderId,
} from "./types";

/**
 * The models a provider currently offers. Anthropic, OpenAI, and local HTTP
 * providers use live list endpoints. Codex uses its app-server model/list
 * method, locally or over SSH. Claude Code intentionally offers its moving
 * aliases because its CLI has no equivalent discovery method. Results cache
 * for 10 minutes; failures fall back to curated.
 */

const CACHE_MS = 10 * 60 * 1000;

export interface OfferedModels {
  models: string[];
  live: boolean;
  effortOptions?: AgentEffort[];
  defaultEffort?: AgentEffort | null;
}

const cache = new Map<string, { at: number; offering: OfferedModels }>();

async function anthropicModels(): Promise<string[]> {
  const client = new Anthropic();
  const models: string[] = [];
  for await (const model of client.models.list()) {
    models.push(model.id);
  }
  return models;
}

async function openaiModels(
  provider: "openai" | Exclude<LocalProviderId, "ollama">,
): Promise<string[]> {
  const baseURL = compatibleBaseUrl(provider);
  const client = new OpenAI({
    apiKey:
      provider === "openai"
        ? process.env.OPENAI_API_KEY || (baseURL ? "unused" : undefined)
        : "unused",
    baseURL,
  });
  const models: string[] = [];
  for await (const model of client.models.list()) {
    if (provider !== "openai" || baseURL || /^(gpt|o\d)/.test(model.id)) {
      models.push(model.id);
    }
  }
  return models.sort().reverse();
}

async function ollamaModels(): Promise<string[]> {
  const response = await fetch(localModelsUrl("ollama"), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = (await response.json()) as {
    models?: { name?: string }[];
  };
  return (data.models ?? [])
    .map((model) => model.name)
    .filter((name): name is string => Boolean(name));
}

interface CodexModelListResult {
  data?: Array<{
    id?: unknown;
    model?: unknown;
    hidden?: unknown;
    isDefault?: unknown;
    defaultReasoningEffort?: unknown;
    supportedReasoningEfforts?: Array<{ reasoningEffort?: unknown }>;
  }>;
  nextCursor?: unknown;
}

interface CodexAppServerMessage {
  id?: unknown;
  result?: CodexModelListResult;
  error?: { message?: unknown };
}

interface CodexModelOffering {
  model: string;
  isDefault: boolean;
  defaultEffort: AgentEffort | null;
  effortOptions: AgentEffort[];
}

/** Discover picker-visible Codex models through the supported app-server API. */
function codexModels(): Promise<Omit<OfferedModels, "live">> {
  const invocation = buildAgentInvocation(
    "codex",
    ["app-server"],
    getCodexSshHost(),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let buffer = "";
    let stderr = "";
    let requestId = 1;
    const offerings: CodexModelOffering[] = [];
    const timer = setTimeout(() => {
      finish(new Error("Codex model discovery timed out."));
    }, 5_000);

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else {
        const selected =
          offerings.find((entry) => entry.model === configuredModel()) ??
          offerings.find((entry) => entry.isDefault) ??
          offerings[0];
        resolve({
          models: offerings.map((entry) => entry.model),
          effortOptions: selected?.effortOptions ?? [],
          defaultEffort: selected?.defaultEffort ?? null,
        });
      }
    }

    function send(message: unknown): void {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function requestPage(cursor?: string): void {
      const params: { limit: number; includeHidden: boolean; cursor?: string } =
        {
          limit: 100,
          includeHidden: false,
        };
      if (cursor) params.cursor = cursor;
      send({ method: "model/list", id: requestId, params });
    }

    function handleLine(line: string): void {
      let message: CodexAppServerMessage;
      try {
        message = JSON.parse(line) as CodexAppServerMessage;
      } catch {
        return;
      }
      if (message.id === 0) {
        if (message.error) {
          finish(new Error("Codex app-server initialization failed."));
          return;
        }
        send({ method: "initialized", params: {} });
        requestPage();
        return;
      }
      if (message.id !== requestId) return;
      if (message.error) {
        const detail =
          typeof message.error.message === "string"
            ? `: ${message.error.message}`
            : "";
        finish(new Error(`Codex model discovery failed${detail}`));
        return;
      }
      for (const entry of message.result?.data ?? []) {
        if (entry.hidden === true) continue;
        const model =
          typeof entry.model === "string"
            ? entry.model
            : typeof entry.id === "string"
              ? entry.id
              : null;
        if (model && !offerings.some((entry) => entry.model === model)) {
          const effortOptions = (entry.supportedReasoningEfforts ?? []).flatMap(
            (option) =>
              isAgentEffort(option.reasoningEffort)
                ? [option.reasoningEffort]
                : [],
          );
          offerings.push({
            model,
            isDefault: entry.isDefault === true,
            defaultEffort: isAgentEffort(entry.defaultReasoningEffort)
              ? entry.defaultReasoningEffort
              : null,
            effortOptions,
          });
        }
      }
      const cursor = message.result?.nextCursor;
      if (typeof cursor === "string" && cursor.length > 0) {
        requestId += 1;
        requestPage(cursor);
        return;
      }
      if (offerings.length === 0) {
        finish(new Error("Codex returned no picker-visible models."));
        return;
      }
      finish();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-500);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) {
        finish(
          new Error(
            `Codex app-server exited with code ${code ?? "unknown"}: ${stderr}`,
          ),
        );
      }
    });

    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "papernook",
          title: "papernook",
          version: "0.1.0",
        },
      },
    });
  });
}

export function resetModelCache(): void {
  cache.clear();
}

export async function listOfferedModels(
  provider: ProviderId,
): Promise<OfferedModels> {
  if (provider === "claude-code") {
    return {
      models: modelSuggestions(provider),
      live: false,
      effortOptions: effortSuggestions(provider),
      defaultEffort: null,
    };
  }

  const cacheKey = `${provider}:${
    provider === "codex"
      ? `${getCodexSshHost() ?? "local"}:${configuredModel() ?? "default"}`
      : (configuredBaseUrl(provider) ?? "")
  }`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.offering;
  }
  try {
    let models: string[] | null = null;
    if (provider === "codex") {
      const offering = { ...(await codexModels()), live: true };
      cache.set(cacheKey, { at: Date.now(), offering });
      return offering;
    } else if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
      models = await anthropicModels();
    } else if (
      provider === "openai" &&
      (process.env.OPENAI_API_KEY || configuredBaseUrl(provider))
    ) {
      models = await openaiModels(provider);
    } else if (provider === "ollama") {
      models = await ollamaModels();
    } else if (isLocalProvider(provider)) {
      models = await openaiModels(provider);
    }
    if (models && models.length > 0) {
      const offering = { models, live: true };
      cache.set(cacheKey, { at: Date.now(), offering });
      return offering;
    }
  } catch {
    // fall through to curated
  }
  const effortOptions = effortSuggestions(provider);
  return {
    models: modelSuggestions(provider),
    live: false,
    ...(effortOptions.length > 0 ? { effortOptions, defaultEffort: null } : {}),
  };
}
