import { describe, expect, it } from "vitest";
import { importTranscript } from "@/lib/conversations/import";
import { richMessage } from "@/lib/conversations/content";

describe("documented provider exports", () => {
  it.each([
    "redacted_reasoning",
    "tool_response",
    "reasoning_recap",
    "function_call_output",
  ])("excludes %s envelopes before looking for nested transcripts", (type) => {
    const source = importTranscript(
      JSON.stringify({
        views: [
          {
            type,
            contents: [
              { role: "model", parts: [{ text: "PRIVATE INTERNAL CONTENT" }] },
            ],
          },
          {
            metadata: { is_visually_hidden_from_conversation: true },
            contents: [{ role: "model", parts: [{ text: "HIDDEN WRAPPER" }] }],
          },
          {
            contents: [
              { role: "model", parts: [{ text: "Visible exported answer" }] },
            ],
          },
        ],
      }),
      "json",
    );
    expect(source.messages).toEqual([
      { role: "assistant", content: "Visible exported answer" },
    ]);
  });
  it("bounds notebook expansion and uses declared code languages and separate traceback lines", () => {
    const state = {
      state: { slider: { state: { value: "x".repeat(100000) } } },
    };
    const outputs = Array.from({ length: 12 }, () => ({
      output_type: "display_data",
      data: {
        "application/vnd.jupyter.widget-view+json": { model_id: "slider" },
      },
    }));
    expect(() =>
      importTranscript(
        JSON.stringify({
          nbformat: 4,
          metadata: {
            widgets: { "application/vnd.jupyter.widget-state+json": state },
          },
          cells: [{ cell_type: "code", source: "x", outputs }],
        }),
        "json",
      ),
    ).toThrow(/transcript limit/);
    const result = importTranscript(
      JSON.stringify({
        nbformat: 4,
        metadata: { language_info: { name: "javascript" } },
        cells: [
          {
            cell_type: "code",
            source: ["const value = 42;"],
            outputs: [
              {
                output_type: "error",
                traceback: ["First error line", "Second error line"],
              },
            ],
          },
        ],
      }),
      "json",
    );
    expect(result.messages[0].content).toContain(
      "```javascript\nconst value = 42;",
    );
    expect(result.messages[0].content).toContain(
      "First error line\nSecond error line",
    );
  });
  it("imports Gemini roles and media while excluding thought and function parts", () => {
    const source = importTranscript(
      JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "Explain this" }] },
          {
            role: "model",
            parts: [
              {
                thought: true,
                text: "Hidden thought",
                inlineData: { mimeType: "image/png", data: "aA==" },
              },
              {
                functionCall: {
                  name: "private_tool",
                  args: { secret: "hidden" },
                },
                text: "Hidden function",
              },
              { text: "Visible answer" },
              { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
              {
                fileData: {
                  mimeType: "video/mp4",
                  fileUri: "https://example.com/movie.mp4",
                },
              },
              {
                fileData: {
                  mimeType: "application/pdf",
                  fileUri: "gs://private/report.pdf",
                },
              },
            ],
          },
        ],
      }),
      "json",
    );
    expect(source.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(source.messages[1].content).toContain("Visible answer");
    expect(source.messages[1].content).not.toMatch(
      /Hidden|private_tool|secret/,
    );
    expect(source.messages[1].assets).toMatchObject([
      { kind: "image", data: "data:image/png;base64,iVBORw0KGgo=" },
      { kind: "video", url: "https://example.com/movie.mp4" },
      { kind: "file", ref: "gs://private/report.pdf" },
    ]);
    expect(source.messages[1].assets?.[2].url).toBeUndefined();
  });

  it("imports visible Gemini candidate content without leaking thought signatures", () => {
    const source = importTranscript(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { thought: true, text: "Hidden" },
                {
                  text: "Answer",
                  thoughtSignature: "opaque private signature",
                },
              ],
            },
          },
        ],
      }),
      "json",
    );
    expect(source.messages).toEqual([{ role: "assistant", content: "Answer" }]);
  });

  it("keeps OpenAI and Claude URL citations with their visible claims", () => {
    const message = richMessage([
      {
        type: "output_text",
        text: "First claim.",
        annotations: [
          {
            type: "url_citation",
            url: "https://example.com/one",
            title: "First source",
            start_index: 0,
            end_index: 12,
          },
        ],
      },
      {
        type: "text",
        text: "Second claim.",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com/two",
            title: "Second source",
            cited_text: "evidence",
            encrypted_index: "private token",
          },
        ],
      },
      {
        type: "thinking",
        text: "Hidden claim",
        citations: [{ url: "https://example.com/hidden" }],
      },
    ]);
    expect(message.content).toContain("First claim.");
    expect(message.content).toContain(
      "[First source](<https://example.com/one>)",
    );
    expect(message.content).toContain(
      "[Second source](<https://example.com/two>)",
    );
    expect(message.citations).toHaveLength(2);
    expect(JSON.stringify(message)).not.toMatch(
      /private token|Hidden claim|example.com\/hidden/,
    );
  });

  it("preserves raw PCM bytes for download without guessing their playback format", () => {
    const result = richMessage({
      inlineData: { mimeType: "audio/L16;rate=24000", data: "AQIDBA==" },
    });
    expect(result.assets?.[0]).toMatchObject({
      kind: "file",
      mime: "audio/L16;rate=24000",
      data: "data:application/octet-stream;base64,AQIDBA==",
    });
    expect(result.content).toContain("Raw PCM audio");
  });

  it("retains all notebook MIME alternatives and saved widget state with exact source lines", () => {
    const bundle = {
      "text/plain": ["one\n", "two"],
      "text/html": ["<table>", "<tr><td>42</td></tr></table>"],
      "application/vnd.plotly.v1+json": { data: [{ x: [1], y: [2] }] },
    };
    const widgets = {
      version_major: 2,
      version_minor: 0,
      state: { slider: { model_name: "IntSliderModel", state: { value: 4 } } },
    };
    const result = importTranscript(
      JSON.stringify({
        nbformat: 4,
        metadata: {
          widgets: { "application/vnd.jupyter.widget-state+json": widgets },
        },
        cells: [
          {
            cell_type: "code",
            source: ["x = 1\n", "print(x)"],
            outputs: [
              { output_type: "display_data", data: bundle, metadata: {} },
            ],
          },
        ],
      }),
      "json",
    );
    expect(result.messages[0].content).toContain("x = 1\nprint(x)");
    expect(result.messages[0].content).not.toContain("x = 1\n\n\nprint");
    const serialized = /```notebook-preview\n([\s\S]*?)\n```/.exec(
      result.messages[0].content,
    )?.[1];
    expect(JSON.parse(serialized!)).toMatchObject({
      data: bundle,
    });
    expect(JSON.parse(serialized!)).not.toHaveProperty("widgetState");
    expect(
      richMessage({
        output_type: "display_data",
        data: {
          "application/vnd.jupyter.widget-view+json": { model_id: "slider" },
        },
        widgetState: widgets,
      }).content,
    ).toContain('"widgetState"');
  });

  it("keeps direct display outputs visible and rejects oversized transformed notebook content", () => {
    expect(
      richMessage({
        output_type: "execute_result",
        execution_count: 1,
        data: { "text/html": "<p>Visible output</p>" },
        metadata: {},
      }).content,
    ).toContain("notebook-preview");
    expect(() =>
      importTranscript(
        JSON.stringify({
          nbformat: 4,
          cells: [
            {
              cell_type: "code",
              source: "x",
              outputs: [
                {
                  output_type: "display_data",
                  data: { "text/plain": "x".repeat(500_001) },
                },
              ],
            },
          ],
        }),
        "json",
      ),
    ).toThrow();
  });
});
