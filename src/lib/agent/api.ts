import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readImageBase64 } from "./attachments";
import {
  DEFAULT_TIMEOUT_MS,
  type AgentProvider,
  type AgentTurn,
} from "./types";

/**
 * API-key providers. Anthropic via the official SDK (adaptive thinking,
 * streaming); OpenAI via its official SDK. Images travel as base64 content
 * blocks. Models are env-configurable; defaults follow current guidance.
 */

const ANTHROPIC_DEFAULT_MODEL = "claude-opus-4-8";
const OPENAI_DEFAULT_MODEL = "gpt-5.5";

function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL;
}

function openaiModel(): string {
  return process.env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL;
}

let anthropicClient: Anthropic | null = null;
function anthropic(): Anthropic {
  anthropicClient ??= new Anthropic();
  return anthropicClient;
}

let openaiClient: OpenAI | null = null;
function openai(): OpenAI {
  openaiClient ??= new OpenAI();
  return openaiClient;
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

async function executeAnthropic(turn: AgentTurn): Promise<string> {
  const stream = anthropic().messages.stream(
    {
      model: anthropicModel(),
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: turn.system || undefined,
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

async function executeOpenAI(turn: AgentTurn): Promise<string> {
  const completion = await openai().chat.completions.create(
    { model: openaiModel(), messages: openaiMessages(turn) },
    { timeout: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  return completion.choices[0]?.message?.content ?? "";
}

async function* streamOpenAI(turn: AgentTurn): AsyncGenerator<string> {
  const stream = await openai().chat.completions.create(
    { model: openaiModel(), messages: openaiMessages(turn), stream: true },
    { timeout: turn.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
  }
}

export const anthropicProvider: AgentProvider = {
  id: "anthropic",
  execute: executeAnthropic,
  stream: streamAnthropic,
};

export const openaiProvider: AgentProvider = {
  id: "openai",
  execute: executeOpenAI,
  stream: streamOpenAI,
};
