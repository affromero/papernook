export type ShareProvider =
  "chatgpt" | "claude" | "gemini" | "grok" | "perplexity";

export interface ShareLocation {
  provider: ShareProvider;
  id: string;
  url: string;
}

export function shareLocation(input: string): ShareLocation {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use a canonical HTTPS public share URL without query parameters.",
    );
  const host = url.hostname;
  const match = /^\/share\/([^/]+)\/?$/.exec(url.pathname);
  const id = match ? decodeURIComponent(match[1]) : "";
  if (
    (host === "chatgpt.com" || host === "claude.ai") &&
    /^[a-f0-9-]{36}$/.test(id)
  )
    return {
      provider: host === "chatgpt.com" ? "chatgpt" : "claude",
      id,
      url: url.href,
    };
  if (host === "gemini.google.com" && /^[a-f0-9]{12}$/.test(id))
    return { provider: "gemini", id, url: url.href };
  if (
    (host === "grok.com" || host === "www.grok.com") &&
    /^[A-Za-z0-9_=-]{8,200}$/.test(id)
  )
    return { provider: "grok", id, url: url.href };
  if (host === "www.perplexity.ai" || host === "perplexity.ai") {
    const slug = /^\/search\/([A-Za-z0-9_.-]{1,300})\/?$/.exec(
      url.pathname,
    )?.[1];
    if (slug) {
      if (
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          slug,
        )
      )
        return { provider: "perplexity", id: slug, url: url.href };
      const encoded = /(?:^|-)([A-Za-z0-9_.-]{22})$/.exec(slug)?.[1];
      if (encoded) {
        const bytes = atob(
          encoded.replace(/[-.]/g, "+").replaceAll("_", "/") + "==",
        );
        if (
          bytes.length === 16 &&
          btoa(bytes)
            .replaceAll("+", ".")
            .replaceAll("/", "_")
            .replace(/=+$/, "") === encoded.replaceAll("-", ".")
        ) {
          const hex = Array.from(bytes, (byte) =>
            byte.charCodeAt(0).toString(16).padStart(2, "0"),
          ).join("");
          return {
            provider: "perplexity",
            id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
            url: url.href,
          };
        }
      }
    }
  }
  throw new Error(
    "Use a public ChatGPT, Claude, Gemini, Grok or Perplexity conversation share link.",
  );
}

export function shareProvider(input: string): ShareProvider {
  return shareLocation(input).provider;
}

export function conversationProvider(source: {
  provider: string;
  sourceUrl?: string;
}): string {
  if (source.provider !== "transcript" || !source.sourceUrl)
    return source.provider;
  try {
    return shareProvider(source.sourceUrl);
  } catch {
    return source.provider;
  }
}

export function refreshableShare(source: { sourceUrl?: string }): boolean {
  if (!source.sourceUrl) return false;
  try {
    shareProvider(source.sourceUrl);
    return true;
  } catch {
    return false;
  }
}
