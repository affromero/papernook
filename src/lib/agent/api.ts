import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readImageBase64 } from "./attachments";
import { configuredModel } from "./config";
import { compatibleBaseUrl } from "./local";
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
    apiKey:
      provider === "openai"
        ? process.env.OPENAI_API_KEY || (baseURL ? "unused" : undefined)
        : "unused",
    baseURL,
  });
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

async function* streamCompatible(
  provider: "openai" | LocalProviderId,
  turn: AgentTurn,
): AsyncGenerator<string> {
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
  // web stays off for now: chat.completions' web_search_options is gated to
  // specific search-preview models, and papernook lets the admin pick any
  // model. Revisit alongside a Responses-API migration.
  capabilities: { web: false, vision: true, unboundedContext: false },
  execute: (turn) => executeCompatible("openai", turn),
  stream: (turn) => streamCompatible("openai", turn),
};

function localProvider(id: LocalProviderId): AgentProvider {
  return {
    id,
    capabilities: { web: false, vision: true, unboundedContext: false },
    execute: (turn) => executeCompatible(id, turn),
    stream: (turn) => streamCompatible(id, turn),
  };
}

export const ollamaProvider = localProvider("ollama");
export const llamacppProvider = localProvider("llamacpp");
export const vllmProvider = localProvider("vllm");
