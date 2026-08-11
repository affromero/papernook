import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/capture/download");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("local-provider web tools", () => {
  it("returns bounded structured SearXNG results", async () => {
    vi.stubEnv("WEB_SEARCH_BASE_URL", "http://search.test:8080");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: Array.from({ length: 7 }, (_, index) => ({
              title: `Result ${index}`,
              url: `https://example.test/${index}`,
              content: `Snippet ${index}`,
            })),
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { executeWebTool } = await import("@/lib/agent/web/tools");

    const output = JSON.parse(
      await executeWebTool("web_search", '{"query":"paper repository"}'),
    ) as unknown[];

    expect(output).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://search.test:8080/search?q=paper+repository&format=json"),
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("converts SSRF-guarded HTML fetches to bounded readable text", async () => {
    const close = vi.fn(async () => {});
    vi.doMock("@/lib/capture/download", () => ({
      fetchPublicUrl: async () => ({
        response: new Response(
          "<html><body><main><h1>Repository</h1><p>Verified code.</p></main><script>secret()</script></body></html>",
          { headers: { "content-type": "text/html" } },
        ),
        url: "https://example.test/repo",
        close,
      }),
    }));
    const { executeWebTool } = await import("@/lib/agent/web/tools");

    const output = JSON.parse(
      await executeWebTool("web_fetch", {
        url: "https://example.test/repo",
      }),
    ) as { content: string; url: string };

    expect(output.url).toBe("https://example.test/repo");
    expect(output.content).toMatch(/repository/i);
    expect(output.content).toContain("Verified code.");
    expect(output.content).not.toContain("secret()");
  });

  it("returns a structured error instead of decoding binary content", async () => {
    vi.doMock("@/lib/capture/download", () => ({
      fetchPublicUrl: async () => ({
        response: new Response("%PDF-binary", {
          headers: { "content-type": "application/pdf" },
        }),
        url: "https://example.test/paper.pdf",
        close: async () => {},
      }),
    }));
    const { executeWebTool } = await import("@/lib/agent/web/tools");

    const output = JSON.parse(
      await executeWebTool("web_fetch", {
        url: "https://example.test/paper.pdf",
      }),
    ) as { error: string; url: string };

    expect(output).toEqual({
      url: "https://example.test/paper.pdf",
      error: "Unsupported content type: application/pdf",
    });
  });

  it("surfaces search backend failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    const { executeWebTool } = await import("@/lib/agent/web/tools");

    await expect(
      executeWebTool("web_search", { query: "current paper" }),
    ).rejects.toThrow("web_search failed with status 503");
  });

  it("blocks web fetches into the server's private network", async () => {
    const { executeWebTool } = await import("@/lib/agent/web/tools");

    await expect(
      executeWebTool("web_fetch", { url: "http://127.0.0.1/private" }),
    ).rejects.toThrow("public internet addresses");
  });
});
