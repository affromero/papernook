import { randomUUID } from "node:crypto";
import {
  ProviderRegistry,
  type CredentialValues,
  type GenerationRequest,
  type Message,
} from "thesidedoor-core/ai";
import { apiProviders } from "thesidedoor-core/ai/providers";
import { PROVIDER_METADATA } from "thesidedoor-core/ai/catalog";
import {
  defineTool,
  ToolRuntime,
  type ToolRuntimeEvent,
} from "thesidedoor-core/ai/tools";
import { readImageBase64 } from "./attachments";
import { configuredModel, readAiState } from "./config";
import { credentialCodec } from "./platform/vault";
import { dataRoot } from "../data-dir";
import {
  invocationMetrics,
  closeInvocationMetrics,
  profileMetricConsumer,
} from "./platform/metrics";
import { executeWebTool, WEB_TOOLS } from "./web/tools";
import {
  DEFAULT_TIMEOUT_MS,
  type AgentProvider,
  type AgentTurn,
  type ProviderId,
} from "./types";

type ApiProviderId = Exclude<ProviderId, "claude-code" | "codex">;
const DEFAULT_MODELS = { anthropic: "claude-opus-4-8", openai: "gpt-5.5" };

export function apiCredentials(
  provider: ApiProviderId,
  state = readAiState(),
): CredentialValues {
  return credentialCodec(state, dataRoot()).resolveState(
    state.credentials,
    provider,
  );
}

function messages(turn: AgentTurn): Message[] {
  const content: Message["content"][number][] = (turn.images ?? []).map(
    (file) => {
      const { mediaType, data } = readImageBase64(file);
      return { type: "image", mediaType, data: Buffer.from(data, "base64") };
    },
  );
  content.push({ type: "text", text: turn.prompt });
  return [
    ...(turn.system
      ? [
          {
            role: "system" as const,
            content: [{ type: "text" as const, text: turn.system }],
          },
        ]
      : []),
    { role: "user", content },
  ];
}

function warningSuffix(warnings: string[]): string {
  return warnings.length
    ? "\n\nWeb access warning: " + warnings.join("; ")
    : "";
}

function invocation(
  provider: ApiProviderId,
  turn: AgentTurn,
  streaming: boolean,
  metrics: ReturnType<typeof invocationMetrics>,
) {
  const state = readAiState();
  const model =
    configuredModel(state.selection) ||
    (provider in DEFAULT_MODELS
      ? DEFAULT_MODELS[provider as keyof typeof DEFAULT_MODELS]
      : PROVIDER_METADATA[provider]?.models[0]?.id);
  if (!model)
    throw new Error(
      provider + ": select a model in Settings before using this provider",
    );
  const values = apiCredentials(provider, state);
  const responses = provider === "openai" && !values.baseUrl;
  const adapters = apiProviders({
    openaiTransport: responses ? "responses" : "chat",
    streaming,
    maxTokensParameter: "max_completion_tokens",
  });
  const adapter = adapters.find((entry) => entry.descriptor.id === provider);
  if (!adapter) throw new Error("Unknown AI provider: " + provider);
  const webTools = Boolean(
    turn.allowWeb && !adapter.descriptor.capabilities.includes("web"),
  );
  const signal = turn.signal
    ? AbortSignal.any([
        turn.signal,
        AbortSignal.timeout(turn.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ])
    : AbortSignal.timeout(turn.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const registry = new ProviderRegistry({
    metrics: metrics?.collector,
    providers: adapters,
    credentials: {
      async resolve() {
        return values;
      },
    },
  });
  const request: GenerationRequest = {
    provider,
    model,
    messages: messages(turn),
    signal,
    consumerId:
      turn.metricOwner === "instance"
        ? "instance"
        : turn.metricOwner
          ? profileMetricConsumer(turn.metricOwner)
          : "unattributed",
    conversationId: randomUUID(),
    credentialOwnerId: "instance",
    timeoutMs: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputTokens: turn.maxOutputTokens,
    adaptiveThinking: provider === "anthropic",
    responseFormat: turn.responseFormat,
    allowWeb: Boolean(turn.allowWeb && !webTools),
  };
  const warnings: string[] = [];
  const tools = WEB_TOOLS.map((tool) => {
    if (tool.type !== "function")
      throw new Error("Unsupported web tool definition");
    return defineTool<Record<string, unknown>, string>({
      name: tool.function.name,
      description: tool.function.description ?? tool.function.name,
      schema: tool.function.parameters ?? { type: "object" },
      effect: "read",
      parse(input) {
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Invalid web tool arguments");
        return input as Record<string, unknown>;
      },
      async authorize() {
        signal.throwIfAborted();
      },
      async execute(input, context) {
        try {
          return await executeWebTool(
            tool.function.name,
            input,
            context.signal,
          );
        } catch (error) {
          context.signal.throwIfAborted();
          const warning =
            tool.function.name +
            " failed: " +
            (error instanceof Error ? error.message : String(error));
          warnings.push(warning);
          return JSON.stringify({ error: warning });
        }
      },
    });
  });
  const runtime = new ToolRuntime({
    registry,
    tools,
    maxToolRounds: 6,
    maxCalls: 256,
    toolTimeoutMs: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    finalAnswerOnLimit: true,
    structuredFinalAnswer: true,
  });
  return {
    events: webTools
      ? runtime.stream(request, "instance")
      : registry.generate(request),
    warnings,
    responses,
  };
}

async function* events(
  provider: ApiProviderId,
  turn: AgentTurn,
  streaming: boolean,
): AsyncGenerator<ToolRuntimeEvent> {
  const metrics = invocationMetrics(turn.metricOwner);
  const started = performance.now();
  let prepared = false;
  try {
    const run = invocation(provider, turn, streaming, metrics);
    prepared = true;
    for await (const event of run.events) {
      if (event.type === "tool_limit")
        run.warnings.push(
          event.limit === "rounds"
            ? "web tool limit reached (6 rounds)"
            : "web tool call limit reached (256 calls)",
        );
      if (
        event.type === "finish" &&
        event.reason === "length" &&
        (run.responses || turn.responseFormat)
      )
        throw new Error(provider + ": response incomplete");
      yield event;
    }
    if (!turn.responseFormat && run.warnings.length)
      yield { type: "text", text: warningSuffix(run.warnings) };
  } catch (error) {
    if (!prepared)
      metrics?.collector.record({
        version: 1,
        id: randomUUID(),
        timestamp: Date.now(),
        kind: "execution",
        operation: "prepare",
        provider,
        outcome: turn.signal?.aborted ? "cancelled" : "error",
        consumerId:
          turn.metricOwner === "instance"
            ? "instance"
            : turn.metricOwner
              ? profileMetricConsumer(turn.metricOwner)
              : undefined,
        credentialOwnerId: "instance",
        durationMs: performance.now() - started,
        inputTokens: null,
        outputTokens: null,
        estimatedCost: null,
        errorCode: "preparation_failed",
      });
    throw error;
  } finally {
    await closeInvocationMetrics(metrics);
  }
}

async function execute(
  provider: ApiProviderId,
  turn: AgentTurn,
): Promise<string> {
  let text = "";
  for await (const event of events(provider, turn, false)) {
    if (event.type === "tool_status" && event.status === "running") text = "";
    if (event.type === "text") text += event.text;
  }
  return text;
}

async function* stream(
  provider: ApiProviderId,
  turn: AgentTurn,
): AsyncGenerator<string> {
  if (turn.responseFormat && turn.allowWeb) {
    yield await execute(provider, turn);
    return;
  }
  for await (const event of events(provider, turn, true))
    if (event.type === "text") yield event.text;
}

export function provider(id: ApiProviderId): AgentProvider {
  return {
    id,
    capabilities: { web: true, vision: true, unboundedContext: false },
    execute: (turn) => execute(id, turn),
    stream: (turn) => stream(id, turn),
  };
}

export const anthropicProvider = provider("anthropic");
export const openaiProvider = provider("openai");
export const ollamaProvider = provider("ollama");
export const llamacppProvider = provider("llamacpp");
export const vllmProvider = provider("vllm");
