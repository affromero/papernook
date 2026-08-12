import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputContent,
} from "openai/resources/responses/responses";
import { readImageBase64 } from "./attachments";
import { configuredModel, storedBaseUrl } from "./config";
import { compatibleBaseUrl } from "./local";
import { executeWebTool, WEB_TOOLS } from "./web/tools";
import {
  DEFAULT_TIMEOUT_MS,
  type AgentProvider,
  type AgentTurn,
  type LocalProviderId,
} from "./types";

/**
 * API-key providers. Anthropic via the official SDK (adaptive thinking,
 * streaming); OpenAI via its official SDK. Images travel as base64 content
 * blocks. Models are env-configurable; defaults follow current guidance.
 */

const ANTHROPIC_DEFAULT_MODEL = "claude-opus-4-8";
const OPENAI_DEFAULT_MODEL = "gpt-5.5";

function anthropicModel(): string {
  return configuredModel() || ANTHROPIC_DEFAULT_MODEL;
}

function openaiModel(): string {
  return configuredModel() || OPENAI_DEFAULT_MODEL;
}

let anthropicClient: Anthropic | null = null;
function anthropic(): Anthropic {
  anthropicClient ??= new Anthropic();
  return anthropicClient;
}

function openai(provider: "openai" | LocalProviderId): OpenAI {
  const baseURL = compatibleBaseUrl(provider);
  return new OpenAI({
    apiKey: provider === "openai" ? openaiApiKey(baseURL) : "unused",
    baseURL,
  });
}

/**
 * OPENAI_API_KEY belongs to api.openai.com. An endpoint typed into Settings
 * is not that host, so sending the real key there would hand it to whatever
 * server an admin (or a hijacked admin session) named; those endpoints
 * authenticate with OPENAI_COMPATIBLE_API_KEY, if anything.
 */
function openaiApiKey(baseURL: string | undefined): string | undefined {
  if (!storedBaseUrl("openai")) {
    return process.env.OPENAI_API_KEY || (baseURL ? "unused" : undefined);
  }
  return process.env.OPENAI_COMPATIBLE_API_KEY || "unused";
}

type AnthropicImageBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  };
};

function anthropicContent(turn: AgentTurn): Anthropic.MessageParam["content"] {
  const images = turn.images ?? [];
  if (images.length === 0) return turn.prompt;
  const blocks: (AnthropicImageBlock | { type: "text"; text: string })[] =
    images.map((filePath) => {
      const { mediaType, data } = readImageBase64(filePath);
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType as AnthropicImageBlock["source"]["media_type"],
          data,
        },
      };
    });
  blocks.push({ type: "text", text: turn.prompt });
  return blocks;
}

/**
 * Server-side web search when the turn allows it. max_uses is kept low so a
 * turn rarely hits stop_reason "pause_turn" (long multi-search turns), which
 * we deliberately do not continuation-loop — an accepted limitation: a
 * paused turn ends with whatever text arrived.
 */
function anthropicTools(
  turn: AgentTurn,
): Anthropic.Messages.ToolUnion[] | undefined {
  if (!turn.allowWeb) return undefined;
  return [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
}

async function executeAnthropic(turn: AgentTurn): Promise<string> {
  const stream = anthropic().messages.stream(
    {
      model: anthropicModel(),
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: turn.system || undefined,
      tools: anthropicTools(turn),
      messages: [{ role: "user", content: anthropicContent(turn) }],
    },
    { timeout: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  const message = await stream.finalMessage();
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function* streamAnthropic(turn: AgentTurn): AsyncGenerator<string> {
  const stream = anthropic().messages.stream(
    {
      model: anthropicModel(),
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: turn.system || undefined,
      tools: anthropicTools(turn),
      messages: [{ role: "user", content: anthropicContent(turn) }],
    },
    { timeout: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function openaiMessages(
  turn: AgentTurn,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const images = turn.images ?? [];
  const content: OpenAIContentPart[] = images.map((filePath) => {
    const { mediaType, data } = readImageBase64(filePath);
    return {
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${data}` },
    };
  });
  content.push({ type: "text", text: turn.prompt });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (turn.system) messages.push({ role: "system", content: turn.system });
  messages.push({
    role: "user",
    content: images.length === 0 ? turn.prompt : content,
  });
  return messages;
}

function openaiResponseInput(turn: AgentTurn): string | ResponseInput {
  const images = turn.images ?? [];
  if (images.length === 0) return turn.prompt;
  const content: ResponseInputContent[] = images.map((filePath) => {
    const { mediaType, data } = readImageBase64(filePath);
    return {
      type: "input_image" as const,
      detail: "auto" as const,
      image_url: `data:${mediaType};base64,${data}`,
    };
  });
  content.push({ type: "input_text", text: turn.prompt });
  return [{ role: "user", content }];
}

function openaiResponseBase(turn: AgentTurn) {
  return {
    model: openaiModel(),
    instructions: turn.system || undefined,
    input: openaiResponseInput(turn),
    store: false,
    ...(turn.allowWeb ? { tools: [{ type: "web_search" as const }] } : {}),
    ...(turn.responseFormat
      ? { text: { format: { type: turn.responseFormat } } }
      : {}),
  };
}

async function executeOpenAI(turn: AgentTurn): Promise<string> {
  if (compatibleBaseUrl("openai")) return executeCompatible("openai", turn);
  const response = await openai("openai").responses.create(
    openaiResponseBase(turn) satisfies ResponseCreateParamsNonStreaming,
    { timeout: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  if (response.status === "failed") {
    throw new Error(`openai: ${response.error?.message ?? "response failed"}`);
  }
  if (response.status === "incomplete") {
    throw new Error("openai: response incomplete");
  }
  return response.output_text;
}

async function* streamOpenAI(turn: AgentTurn): AsyncGenerator<string> {
  if (compatibleBaseUrl("openai")) {
    yield* streamCompatible("openai", turn);
    return;
  }
  const stream = await openai("openai").responses.create(
    {
      ...openaiResponseBase(turn),
      stream: true,
    } satisfies ResponseCreateParamsStreaming,
    { timeout: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") yield event.delta;
    if (event.type === "error") {
      throw new Error(`openai: ${event.message}`);
    }
    if (event.type === "response.failed") {
      throw new Error(
        `openai: ${event.response.error?.message ?? "response failed"}`,
      );
    }
    if (event.type === "response.incomplete") {
      throw new Error("openai: response incomplete");
    }
  }
}

function compatibleModel(provider: "openai" | LocalProviderId): string {
  const model = provider === "openai" ? openaiModel() : configuredModel();
  if (!model) {
    throw new Error(
      `${provider}: select a model in Settings before using this provider`,
    );
  }
  return model;
}

async function executeCompatible(
  provider: "openai" | LocalProviderId,
  turn: AgentTurn,
): Promise<string> {
  if (turn.allowWeb) {
    return executeCompatibleWithWeb(provider, turn);
  }
  const completion = await openai(provider).chat.completions.create(
    {
      model: compatibleModel(provider),
      messages: openaiMessages(turn),
      ...(turn.responseFormat
        ? { response_format: { type: turn.responseFormat } }
        : {}),
    },
    { timeout: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  return completion.choices[0]?.message?.content ?? "";
}

const MAX_WEB_TOOL_ROUNDS = 6;

type CompatibleMessage = OpenAI.Chat.ChatCompletionMessageParam;
type CompatibleFunctionCall = OpenAI.Chat.ChatCompletionMessageFunctionToolCall;

function remainingTimeout(provider: string, deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new Error(`${provider}: timed out during web access`);
  return remaining;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warningSuffix(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return `\n\nWeb access warning: ${warnings.join("; ")}`;
}

async function withinDeadline<T>(
  operation: Promise<T>,
  provider: string,
  deadline: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("web tool timed out")),
          remainingTimeout(provider, deadline),
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function appendWebToolResults(
  messages: CompatibleMessage[],
  calls: CompatibleFunctionCall[],
  warnings: string[],
  provider: string,
  deadline: number,
): Promise<void> {
  for (const call of calls) {
    let content: string;
    try {
      content = await withinDeadline(
        executeWebTool(call.function.name, call.function.arguments),
        provider,
        deadline,
      );
    } catch (error) {
      const warning = `${call.function.name} failed: ${errorMessage(error)}`;
      warnings.push(warning);
      content = JSON.stringify({ error: warning });
    }
    messages.push({ role: "tool", tool_call_id: call.id, content });
  }
}

function functionCalls(
  provider: string,
  toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[],
): CompatibleFunctionCall[] {
  const calls = toolCalls.filter(
    (call): call is CompatibleFunctionCall => call.type === "function",
  );
  if (calls.length !== toolCalls.length) {
    throw new Error(`${provider}: returned an unsupported custom tool call`);
  }
  return calls;
}

async function finalCompatibleAnswer(
  provider: "openai" | LocalProviderId,
  turn: AgentTurn,
  messages: CompatibleMessage[],
  warnings: string[],
  deadline: number,
): Promise<string> {
  const completion = await openai(provider).chat.completions.create(
    {
      model: compatibleModel(provider),
      messages,
      ...(turn.responseFormat
        ? { response_format: { type: turn.responseFormat } }
        : {}),
    },
    { timeout: remainingTimeout(provider, deadline) },
  );
  const content = completion.choices[0]?.message?.content ?? "";
  return turn.responseFormat ? content : content + warningSuffix(warnings);
}

async function executeCompatibleWithWeb(
  provider: "openai" | LocalProviderId,
  turn: AgentTurn,
): Promise<string> {
  const messages = openaiMessages(turn);
  const warnings: string[] = [];
  const deadline = Date.now() + (turn.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (let round = 0; round < MAX_WEB_TOOL_ROUNDS; round += 1) {
    const completion = await openai(provider).chat.completions.create(
      {
        model: compatibleModel(provider),
        messages,
        tools: WEB_TOOLS,
        parallel_tool_calls: false,
      },
      { timeout: remainingTimeout(provider, deadline) },
    );
    const message = completion.choices[0]?.message;
    if (!message) throw new Error(`${provider}: no response message produced`);
    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      if (!turn.responseFormat) {
        return (message.content ?? "") + warningSuffix(warnings);
      }
      return finalCompatibleAnswer(
        provider,
        turn,
        messages,
        warnings,
        deadline,
      );
    }
    const calls = functionCalls(provider, toolCalls);
    messages.push({
      role: "assistant",
      content: message.content,
      tool_calls: calls,
    });
    await appendWebToolResults(messages, calls, warnings, provider, deadline);
  }
  warnings.push(`web tool limit reached (${MAX_WEB_TOOL_ROUNDS} rounds)`);
  return finalCompatibleAnswer(provider, turn, messages, warnings, deadline);
}

interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function completeStreamedCalls(
  provider: string,
  calls: Map<number, StreamedToolCall>,
): CompatibleFunctionCall[] {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (!call.id || !call.name) {
        throw new Error(`${provider}: returned an incomplete web tool call`);
      }
      return {
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      };
    });
}

async function* streamCompatibleWithWeb(
  provider: "openai" | LocalProviderId,
  turn: AgentTurn,
): AsyncGenerator<string> {
  if (turn.responseFormat) {
    yield await executeCompatibleWithWeb(provider, turn);
    return;
  }
  const messages = openaiMessages(turn);
  const warnings: string[] = [];
  const deadline = Date.now() + (turn.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  for (let round = 0; round < MAX_WEB_TOOL_ROUNDS; round += 1) {
    const stream = await openai(provider).chat.completions.create(
      {
        model: compatibleModel(provider),
        messages,
        tools: WEB_TOOLS,
        parallel_tool_calls: false,
        stream: true,
      },
      { timeout: remainingTimeout(provider, deadline) },
    );
    const streamedCalls = new Map<number, StreamedToolCall>();
    let content = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        yield delta.content;
      }
      for (const call of delta.tool_calls ?? []) {
        const current = streamedCalls.get(call.index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        current.id += call.id ?? "";
        current.name += call.function?.name ?? "";
        current.arguments += call.function?.arguments ?? "";
        streamedCalls.set(call.index, current);
      }
    }
    const calls = completeStreamedCalls(provider, streamedCalls);
    if (calls.length === 0) {
      const suffix = warningSuffix(warnings);
      if (suffix) yield suffix;
      return;
    }
    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: calls,
    });
    await appendWebToolResults(messages, calls, warnings, provider, deadline);
  }
  warnings.push(`web tool limit reached (${MAX_WEB_TOOL_ROUNDS} rounds)`);
  const finalStream = await openai(provider).chat.completions.create(
    {
      model: compatibleModel(provider),
      messages,
      stream: true,
    },
    { timeout: remainingTimeout(provider, deadline) },
  );
  for await (const chunk of finalStream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
  yield warningSuffix(warnings);
}

async function* streamCompatible(
  provider: "openai" | LocalProviderId,
  turn: AgentTurn,
): AsyncGenerator<string> {
  if (turn.allowWeb) {
    yield* streamCompatibleWithWeb(provider, turn);
    return;
  }
  const stream = await openai(provider).chat.completions.create(
    {
      model: compatibleModel(provider),
      messages: openaiMessages(turn),
      stream: true,
      ...(turn.responseFormat
        ? { response_format: { type: turn.responseFormat } }
        : {}),
    },
    { timeout: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

export const anthropicProvider: AgentProvider = {
  id: "anthropic",
  capabilities: { web: true, vision: true, unboundedContext: false },
  execute: executeAnthropic,
  stream: streamAnthropic,
};

export const openaiProvider: AgentProvider = {
  id: "openai",
  capabilities: { web: true, vision: true, unboundedContext: false },
  execute: executeOpenAI,
  stream: streamOpenAI,
};

function localProvider(id: LocalProviderId): AgentProvider {
  return {
    id,
    capabilities: { web: true, vision: true, unboundedContext: false },
    execute: (turn) => executeCompatible(id, turn),
    stream: (turn) => streamCompatible(id, turn),
  };
}

export const ollamaProvider = localProvider("ollama");
export const llamacppProvider = localProvider("llamacpp");
export const vllmProvider = localProvider("vllm");
