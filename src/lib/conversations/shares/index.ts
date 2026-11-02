import { fetchPublicUrl } from "@/lib/capture/download";
import { readBoundedResponse } from "@/lib/capture/bounded-response";
import { geminiTranscript } from "./gemini";
import { grokTranscript } from "./grok";
import { perplexityTranscript } from "./perplexity";
import { shareLocation } from "./urls";
import type { ShareTranscript } from "./schema";
import { object } from "./schema";

async function readShare(
  endpoint: URL,
  provider: string,
  signal: AbortSignal,
  budget: { remaining: number },
  form?: string,
): Promise<string> {
  if (budget.remaining <= 0)
    throw new Error("Public conversation exceeds the 8 MB download limit.");
  const fetched = await fetchPublicUrl(
    endpoint.href,
    signal,
    form === undefined
      ? undefined
      : { body: form, contentType: "application/x-www-form-urlencoded" },
  );
  if (!fetched.response.ok || fetched.url !== endpoint.href) {
    try {
      await fetched.response.body?.cancel();
    } finally {
      await fetched.close();
    }
    throw new Error(
      `${provider} did not expose this public conversation (HTTP ${fetched.response.status}). It may have been deleted, require login or block automated access. Import an exported transcript instead.`,
    );
  }
  const body = await readBoundedResponse(
    fetched.response,
    budget.remaining,
    fetched.close,
  );
  budget.remaining -= body.length;
  return body.toString("utf8");
}

function parseJson(body: string, provider: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${provider} returned an unreadable public conversation.`);
  }
}

export async function loadProviderShare(
  input: string,
): Promise<ShareTranscript> {
  const { provider, id } = shareLocation(input);
  const signal = AbortSignal.timeout(60_000);
  let endpoint: URL;
  let form: string | undefined;
  if (provider === "gemini") {
    endpoint = new URL(
      "https://gemini.google.com/_/BardChatUi/data/batchexecute",
    );
    endpoint.search = new URLSearchParams({
      rpcids: "ujx1Bf",
      "source-path": `/share/${id}`,
      rt: "c",
    }).toString();
    form = new URLSearchParams({
      "f.req": JSON.stringify([
        [["ujx1Bf", JSON.stringify([null, id, [4]]), null, "generic"]],
      ]),
    }).toString();
  } else if (provider === "grok") {
    endpoint = new URL(
      `https://grok.com/rest/app-chat/share_links/${encodeURIComponent(id)}?useChunk=true`,
    );
  } else if (provider === "perplexity") {
    endpoint = new URL(`https://www.perplexity.ai/rest/thread/${id}`);
    endpoint.search = new URLSearchParams({
      with_schematized_response: "true",
      version: "2.18",
      from_first: "true",
      limit: "100",
      offset: "0",
      supported_block_use_cases: "media_items",
    }).toString();
  } else
    throw new Error("This provider uses a different public-share transport.");
  const budget = { remaining: 8 * 1024 * 1024 };
  const body = await readShare(endpoint, provider, signal, budget, form);
  if (provider === "gemini") return geminiTranscript(body, id);
  let payload = parseJson(body, provider);
  if (provider === "grok") return grokTranscript(payload);
  const entries: unknown[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  for (;;) {
    const page = object(payload);
    if (
      !page ||
      !Array.isArray(page.entries) ||
      typeof page.has_next_page !== "boolean"
    )
      throw new Error("Perplexity returned an unsupported history page.");
    for (const value of page.entries) {
      const key = object(value)?.uuid;
      if (typeof key === "string") {
        if (seen.has(key))
          throw new Error(
            "Perplexity repeated a history page. Import a complete export instead.",
          );
        seen.add(key);
      } else if (page.has_next_page || entries.length)
        throw new Error("Perplexity omitted its history identifiers.");
    }
    entries.push(...page.entries);
    if (entries.length > 1000)
      throw new Error("Shared conversation exceeds the 2,000-message limit.");
    if (!page.has_next_page)
      return perplexityTranscript(
        { ...page, entries, has_next_page: false },
        id,
      );
    if (!page.entries.length)
      throw new Error("Perplexity returned an incomplete history page.");
    if (
      typeof page.next_cursor !== "string" ||
      !page.next_cursor ||
      page.next_cursor.length > 8192 ||
      cursors.has(page.next_cursor)
    )
      throw new Error("Perplexity omitted or repeated its history cursor.");
    cursors.add(page.next_cursor);
    endpoint.searchParams.set("cursor", page.next_cursor);
    payload = parseJson(
      await readShare(endpoint, provider, signal, budget),
      provider,
    );
  }
}
