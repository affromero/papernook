import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  geminiShare,
  geminiShareId,
  grokShare,
  grokShareId,
  perplexityShare,
  perplexityShareId,
} from "../../helpers/conversation-providers";
import { geminiTranscript } from "@/lib/conversations/shares/gemini";
import { grokTranscript } from "@/lib/conversations/shares/grok";
import { perplexityTranscript } from "@/lib/conversations/shares/perplexity";
import {
  conversationProvider,
  refreshableShare,
  shareLocation,
} from "@/lib/conversations/shares/urls";
import { importTranscript } from "@/lib/conversations/import";

const boundary = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetch: vi.fn(),
  closed: false,
}));
vi.mock("node:dns/promises", () => ({ lookup: boundary.lookup }));
vi.mock("undici", () => ({
  Agent: class {
    async close() {
      boundary.closed = true;
    }
  },
  fetch: boundary.fetch,
}));

beforeEach(() => {
  vi.resetModules();
  boundary.lookup
    .mockReset()
    .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  boundary.fetch.mockReset();
  boundary.closed = false;
});

describe("verified public-share formats", () => {
  it("retains provider web references alongside citations from included media", () => {
    const root = perplexityShare();
    const raw = perplexityTranscript({
      ...root,
      entries: [
        {
          ...root.entries[0],
          blocks: [
            ...("blocks" in root.entries[0] ? root.entries[0].blocks : []),
            {
              intended_usage: "media_items",
              media_block: {
                media_items: [
                  {
                    medium: "video",
                    url: "https://example.com/video",
                    name: "Related video",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const source = importTranscript(JSON.stringify(raw), "json");
    expect(source.messages[1].citations).toEqual(
      expect.arrayContaining([
        {
          ref: "1",
          title: "Published source",
          url: "https://example.com/source",
        },
        expect.objectContaining({
          title: "Related video",
          url: "https://example.com/video",
        }),
      ]),
    );
    expect(source.messages[1].content).toContain("\uE200cite\uE2021\uE201");
  });

  it("excludes hidden provider media, citations, answer envelopes and unknown widget state", () => {
    const hidden = { metadata: { is_visually_hidden_from_conversation: true } };
    const grok = grokShare();
    const sanitized = grokTranscript({
      ...grok,
      responses: [
        {
          ...grok.responses[3],
          imageAttachments: [{ ...hidden, url: "https://example.com/PRIVATE" }],
          citedWebSearchResults: [
            { ...hidden, url: "https://example.com/PRIVATE" },
          ],
        },
      ],
    });
    expect(JSON.stringify(sanitized)).not.toContain("PRIVATE");
    const root = perplexityShare();
    const entry = root.entries[0];
    const make = (blocks: unknown[]) => ({
      ...root,
      entries: [{ ...entry, blocks }],
    });
    expect(() =>
      perplexityTranscript(
        make([
          {
            intended_usage: "ask_text",
            markdown_block: { ...hidden, progress: "DONE", answer: "PRIVATE" },
          },
        ]),
      ),
    ).toThrow("visible answer");
    const hiddenMedia = perplexityTranscript(
      make([
        ...("blocks" in entry ? entry.blocks : []),
        {
          intended_usage: "media_items",
          media_block: {
            ...hidden,
            media_items: [
              { medium: "image", url: "https://example.com/PRIVATE" },
            ],
          },
        },
      ]),
    );
    expect(JSON.stringify(hiddenMedia)).not.toContain("PRIVATE");
    for (const location of ["step", "content", "answer"]) {
      const answer = {
        ...(location === "answer" ? hidden : {}),
        answer: "PRIVATE",
      };
      const content = {
        ...(location === "content" ? hidden : {}),
        answer: JSON.stringify(answer),
      };
      const step = {
        ...(location === "step" ? hidden : {}),
        step_type: "FINAL",
        content,
      };
      expect(() =>
        perplexityTranscript({
          ...root,
          entries: [
            { ...entry, blocks: undefined, text: JSON.stringify([step]) },
          ],
        }),
      ).toThrow("visible answer");
    }
    const widgets = perplexityTranscript(
      make([
        ...("blocks" in entry ? entry.blocks : []),
        {
          intended_usage: "finance_widgets",
          finance_widget: {
            symbol: "ABC",
            internal: { type: "reasoning", text: "PRIVATE" },
          },
        },
      ]),
    );
    expect(
      JSON.stringify(importTranscript(JSON.stringify(widgets), "json")),
    ).not.toContain("PRIVATE");
  });
  it("reads only the published Gemini candidate and preserves math", () => {
    const raw = geminiTranscript(geminiShare(), geminiShareId);
    const source = importTranscript(JSON.stringify(raw), "json");
    expect(source.messages).toEqual([
      { role: "user", content: "A public question" },
      { role: "assistant", content: "A visible answer with $x^2$." },
    ]);
    expect(JSON.stringify(source)).not.toContain("PRIVATE");
    expect(() => geminiTranscript(geminiShare(), "ffffffffffff")).toThrow(
      "mismatched",
    );
    expect(() =>
      geminiTranscript(geminiShare().replace("ujx1Bf", "other"), geminiShareId),
    ).toThrow("unreadable");
    expect(() => geminiTranscript(geminiShare(""), geminiShareId)).toThrow(
      "completed answer",
    );
  });

  it("keeps Grok final text, media and sources while rejecting control and reasoning chunks", () => {
    const source = importTranscript(
      JSON.stringify(grokTranscript(grokShare())),
      "json",
    );
    expect(source.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(source.messages[1]).toMatchObject({
      content: expect.stringContaining("A visible answer"),
      assets: [{ kind: "image", url: "https://images.example/chart.png" }],
      citations: [{ ref: "1", url: "https://example.com/source" }],
    });
    expect(JSON.stringify(source)).not.toContain("PRIVATE");
    expect(() => grokTranscript({ ...grokShare(), isPublic: false })).toThrow(
      "not publicly",
    );
    const partial = grokShare();
    partial.responses[3].partial = true;
    expect(() => grokTranscript(partial)).toThrow("still generating");
  });

  it.each([false, true])(
    "reads Perplexity completed answers and citations from legacy=%s without leaking private fields",
    (legacy) => {
      const source = importTranscript(
        JSON.stringify(perplexityTranscript(perplexityShare(legacy))),
        "json",
      );
      expect(source.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(source.messages[1].content).toContain(
        "A visible answer \uE200cite\uE2021\uE201",
      );
      expect(source.messages[1].content).toContain("`[1]`");
      expect(source.messages[1].citations).toEqual([
        {
          ref: "1",
          title: "Published source",
          url: "https://example.com/source",
        },
      ]);
      expect(JSON.stringify(source)).not.toContain("PRIVATE");
    },
  );

  it("rejects private, unfinished, missing and partial Perplexity history", () => {
    const root = perplexityShare();
    expect(() =>
      perplexityTranscript({ ...root, has_next_page: true }),
    ).toThrow("only part");
    for (const patch of [
      { access_level: "PRIVATE" },
      { thread_access: 0 },
      { privacy_state: "PRIVATE" },
      { status: "STREAMING" },
      { blocks: [] },
    ])
      expect(() =>
        perplexityTranscript({
          ...root,
          entries: [{ ...root.entries[0], ...patch }],
        }),
      ).toThrow();
  });
});

describe("share URL identity", () => {
  it("binds canonical Perplexity slugs to exactly one 16-byte public thread ID", () => {
    expect(
      shareLocation(
        "https://www.perplexity.ai/search/example-Hwb2WXMVSEW2w752G5R7Xw",
      ),
    ).toMatchObject({ provider: "perplexity", id: perplexityShareId });
    expect(
      shareLocation(`https://www.perplexity.ai/search/${perplexityShareId}`),
    ).toMatchObject({ id: perplexityShareId });
    expect(
      shareLocation(
        "https://www.perplexity.ai/search/example-2PMY0ql.Rde0ks_XcP3k.g",
      ),
    ).toMatchObject({ id: "d8f318d2-a97e-45d7-b492-cfd770fde4fa" });
    expect(() =>
      shareLocation(
        "https://www.perplexity.ai/search/example-Hwb2WXMVSEW2w752G5R7Xx",
      ),
    ).toThrow();
  });

  it.each([
    "https://gemini.google.com.evil.test/share/0123456789ab",
    "https://grok.com/c/00000000-0000-0000-0000-000000000001",
    "https://user@grok.com/share/abcdefgh",
    "https://grok.com:8443/share/abcdefgh",
    "https://grok.com/share/abcdefgh?token=private",
    "https://grok.com/share/abcdefgh%2Fprivate",
    "https://www.perplexity.ai/search/private",
    "https://www.perplexity.ai/search/Hwb2WXMVSEW2w752G5R7Xw#private",
  ])("rejects private or noncanonical input %s", (url) =>
    expect(() => shareLocation(url)).toThrow(),
  );

  it("labels generic snapshots from their canonical share without changing their stored schema", () => {
    const source = {
      provider: "transcript",
      sourceUrl: `https://gemini.google.com/share/${geminiShareId}`,
    };
    expect(conversationProvider(source)).toBe("gemini");
    expect(refreshableShare(source)).toBe(true);
    expect(
      conversationProvider({
        ...source,
        sourceUrl: "https://example.com/private",
      }),
    ).toBe("transcript");
    expect(refreshableShare({ sourceUrl: "https://example.com/private" })).toBe(
      false,
    );
  });
});

describe("guarded provider transport", () => {
  it.each([
    [
      "gemini",
      `https://gemini.google.com/share/${geminiShareId}`,
      () => geminiShare(),
    ],
    [
      "grok",
      `https://grok.com/share/${grokShareId}`,
      () => JSON.stringify(grokShare()),
    ],
    [
      "perplexity",
      `https://www.perplexity.ai/search/${perplexityShareId}`,
      () => JSON.stringify(perplexityShare()),
    ],
  ] as const)(
    "imports %s through the canonical transport without sending account credentials",
    async (provider, url, body) => {
      boundary.fetch.mockResolvedValue(new Response(body()));
      const { importShare } = await import("@/lib/conversations/import");
      const source = await importShare(url);
      expect(source).toMatchObject({ provider: "transcript", sourceUrl: url });
      expect(source.messages).toHaveLength(2);
      expect(conversationProvider(source)).toBe(provider);
      expect(JSON.stringify(source)).not.toContain("PRIVATE");
      expect(boundary.closed).toBe(true);
      const [endpoint, request] = boundary.fetch.mock.calls[0];
      expect(new URL(endpoint).hostname).toBe(
        provider === "gemini"
          ? "gemini.google.com"
          : provider === "grok"
            ? "grok.com"
            : "www.perplexity.ai",
      );
      expect(request.headers).not.toHaveProperty("Authorization");
      expect(request.headers).not.toHaveProperty("Cookie");
      expect(request.headers).not.toHaveProperty("X-Sharing-Operation");
      if (provider === "gemini") {
        expect(request.method).toBe("POST");
        expect(request.headers["Content-Type"]).toBe(
          "application/x-www-form-urlencoded",
        );
        expect(
          JSON.parse(new URLSearchParams(request.body).get("f.req")!),
        ).toEqual([
          [
            [
              "ujx1Bf",
              JSON.stringify([null, geminiShareId, [4]]),
              null,
              "generic",
            ],
          ],
        ]);
      } else expect(request.method).toBe("GET");
    },
  );

  it("closes unavailable provider responses and reports the HTTP status", async () => {
    boundary.fetch.mockResolvedValue(
      new Response("Private upstream page", { status: 403 }),
    );
    const { importShare } = await import("@/lib/conversations/import");
    await expect(
      importShare(`https://gemini.google.com/share/${geminiShareId}`),
    ).rejects.toThrow("HTTP 403");
    expect(boundary.closed).toBe(true);
  });

  it("collects complete Perplexity pages in provider order and binds them to the requested share", async () => {
    const first = perplexityShare();
    const second = perplexityShare();
    const page = (
      root: ReturnType<typeof perplexityShare>,
      uuid: string,
      query: string,
      more: boolean,
    ) => ({
      ...root,
      has_next_page: more,
      next_cursor: more ? "saved-cursor" : null,
      entries: [{ ...root.entries[0], uuid, query_str: query }],
    });
    boundary.fetch
      .mockResolvedValueOnce(
        Response.json(page(first, "first-entry", "First question", true)),
      )
      .mockResolvedValueOnce(
        Response.json(page(second, "second-entry", "Second question", false)),
      );
    const { importShare } = await import("@/lib/conversations/import");
    const source = await importShare(
      `https://www.perplexity.ai/search/${perplexityShareId}`,
    );
    expect(
      source.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["First question", "Second question"]);
    expect(
      boundary.fetch.mock.calls.map((call) =>
        new URL(call[0]).searchParams.get("cursor"),
      ),
    ).toEqual([null, "saved-cursor"]);
    expect(boundary.closed).toBe(true);
  }, 10_000);

  it("rejects repeated Perplexity pages instead of duplicating or truncating the conversation", async () => {
    const root = perplexityShare();
    const entry = { ...root.entries[0], uuid: "repeated-entry" };
    boundary.fetch
      .mockResolvedValueOnce(
        Response.json({
          ...root,
          has_next_page: true,
          next_cursor: "saved-cursor",
          entries: [entry],
        }),
      )
      .mockResolvedValueOnce(Response.json({ ...root, entries: [entry] }));
    const { importShare } = await import("@/lib/conversations/import");
    await expect(
      importShare(`https://www.perplexity.ai/search/${perplexityShareId}`),
    ).rejects.toThrow("repeated a history page");
  }, 10_000);

  it("retains DNS pinning and rejects private addresses for form requests", async () => {
    boundary.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const { importShare } = await import("@/lib/conversations/import");
    await expect(
      importShare(`https://gemini.google.com/share/${geminiShareId}`),
    ).rejects.toThrow("public internet");
    expect(boundary.fetch).not.toHaveBeenCalled();
  });

  it("refuses form redirects rather than forwarding the public request to another origin", async () => {
    boundary.fetch.mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/" },
      }),
    );
    const { importShare } = await import("@/lib/conversations/import");
    await expect(
      importShare(`https://gemini.google.com/share/${geminiShareId}`),
    ).rejects.toThrow("must not redirect");
    expect(boundary.closed).toBe(true);
    expect(
      boundary.fetch.mock.calls.map((call) => new URL(call[0]).hostname),
    ).toEqual(["gemini.google.com"]);
  });
});
