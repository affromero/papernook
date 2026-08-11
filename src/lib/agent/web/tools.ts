import type OpenAI from "openai";
import { convert } from "html-to-text";
import { z } from "zod";
import { readBoundedResponse } from "../../capture/bounded-response";
import { fetchPublicUrl } from "../../capture/download";

const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_PAGE_CHARS = 40_000;
const MAX_RESULTS = 5;

const searchArgs = z.object({
  query: z.string().trim().min(1).max(500),
});
const fetchArgs = z.object({
  url: z.url().max(2_000),
});

const searchResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().optional().default("Untitled"),
      url: z.string(),
      content: z.string().optional(),
    }),
  ),
});

export const WEB_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web for current, relevant sources.",
      strict: true,
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch readable text from a public HTTP(S) URL returned by web_search.",
      strict: true,
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
];

function searchBaseUrl(): string {
  return (
    process.env.WEB_SEARCH_BASE_URL?.replace(/\/+$/, "") ||
    "http://127.0.0.1:8888"
  );
}

function parseArguments(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value) as unknown;
  return value;
}

async function webSearch(argumentsValue: unknown): Promise<string> {
  const { query } = searchArgs.parse(parseArguments(argumentsValue));
  const url = new URL("/search", searchBaseUrl());
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`web_search failed with status ${response.status}`);
  }
  const bytes = await readBoundedResponse(response, MAX_SEARCH_BYTES);
  const parsed = searchResponse.parse(JSON.parse(bytes.toString("utf8")));
  return JSON.stringify(
    parsed.results.slice(0, MAX_RESULTS).map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.content ?? "",
    })),
  );
}

async function webFetch(argumentsValue: unknown): Promise<string> {
  const { url } = fetchArgs.parse(parseArguments(argumentsValue));
  const fetched = await fetchPublicUrl(url);
  if (!fetched.response.ok) {
    await fetched.close();
    throw new Error(`web_fetch failed with status ${fetched.response.status}`);
  }
  const contentType = fetched.response.headers.get("content-type") ?? "";
  const bytes = await readBoundedResponse(
    fetched.response,
    MAX_PAGE_BYTES,
    fetched.close,
  );
  const raw = bytes.toString("utf8");
  const isHtml = contentType.includes("html");
  const isText =
    !contentType ||
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript");
  if (!isHtml && !isText) {
    return JSON.stringify({
      url: fetched.url,
      error: `Unsupported content type: ${contentType || "unknown"}`,
    });
  }
  const text = isHtml
    ? convert(raw, {
        wordwrap: false,
        selectors: [
          { selector: "script", format: "skip" },
          { selector: "style", format: "skip" },
          { selector: "svg", format: "skip" },
        ],
      })
    : raw;
  return JSON.stringify({
    url: fetched.url,
    content: text.replace(/\n{3,}/g, "\n\n").slice(0, MAX_PAGE_CHARS),
    truncated: text.length > MAX_PAGE_CHARS,
  });
}

export async function executeWebTool(
  name: string,
  argumentsValue: unknown,
): Promise<string> {
  if (name === "web_search") return webSearch(argumentsValue);
  if (name === "web_fetch") return webFetch(argumentsValue);
  throw new Error(`Unsupported web tool: ${name}`);
}
