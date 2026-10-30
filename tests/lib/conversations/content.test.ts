import { describe, expect, it } from "vitest";
import { importTranscript } from "@/lib/conversations/import";
import { normalizeProviderText } from "@/lib/chat/normalize-provider-text";
import { prepareSvg } from "@/lib/conversations/preview";

describe("rich conversation imports", () => {
  it("retains large code samples with many literal backticks and their following text", () => {
    const code = "`x` ".repeat(70_000);
    const result = importTranscript(
      JSON.stringify({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "code", language: "text", code },
              { type: "text", text: "Following explanation" },
            ],
          },
        ],
      }),
      "json",
    );
    expect(result.messages[0].content).toContain(code);
    expect(result.messages[0].content).toMatch(
      /\n```\n\nFollowing explanation$/,
    );
  });
  it("retains structured layout source verbatim so existing imports can be rendered without refetching", () => {
    const content =
      '<box border padding={3}><grid columns={2}><grid-item><text>Road map</text></grid-item><grid-item><text>Actors</text></grid-item></grid><icon name="arrow-down"/></box>';
    const result = importTranscript(
      JSON.stringify({ messages: [{ role: "assistant", content }] }),
      "json",
    );
    expect(result.messages[0].content).toBe(content);
  });
  it("imports nested provider files, input audio and transcriptions while excluding internal records", () => {
    const source = importTranscript(
      JSON.stringify({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "input_audio",
                input_audio: { data: "YQ==", format: "wav" },
              },
              {
                type: "file",
                file: {
                  filename: "report.pdf",
                  file_data: "data:application/pdf;base64,JVBERi0=",
                },
              },
              { type: "audio_transcription", text: "Spoken explanation" },
              {
                type: "reasoning",
                encrypted_content: "private reasoning",
                summary: [{ text: "Hidden summary" }],
              },
              { type: "tool_call", arguments: "Private tool arguments" },
            ],
          },
        ],
      }),
      "json",
    ).messages[0];
    expect(source.assets?.[0]).toMatchObject({
      kind: "audio",
      data: "data:audio/wav;base64,YQ==",
    });
    expect(source.assets?.[1]).toMatchObject({
      kind: "file",
      name: "report.pdf",
      data: "data:application/pdf;base64,JVBERi0=",
    });
    expect(source.content).toContain("Spoken explanation");
    expect(source.content).not.toContain("private reasoning");
    expect(source.content).not.toContain("Hidden summary");
    expect(source.content).not.toContain("Private tool arguments");
  });

  it("retains standard citation markers as source links when metadata resolves them", () => {
    expect(
      normalizeProviderText("A claim. \uE200cite\uE202turn1search0\uE201", {
        citations: [
          {
            ref: "turn1search0",
            title: "Original source",
            url: "https://example.com/reference",
          },
        ],
      }),
    ).toContain("[Original source](<https://example.com/reference>)");
  });
  it("retains images, media, files, tables, math and renderable artifacts in source order", () => {
    const source = importTranscript(
      JSON.stringify({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "A rich answer" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBORw0KGgo=",
                },
              },
              {
                type: "audio",
                url: "https://example.com/voice.mp3",
                mime_type: "audio/mpeg",
                name: "Voice",
              },
              {
                type: "video",
                url: "https://example.com/clip.mp4",
                mime_type: "video/mp4",
                name: "Clip",
              },
              {
                type: "document",
                source: { url: "https://example.com/report.pdf" },
                name: "Report",
              },
              {
                type: "table",
                columns: ["Name", "Score"],
                rows: [["Road", 42]],
              },
              { type: "math", latex: "x^2" },
              {
                type: "artifact",
                mime_type: "text/html",
                content: "<p>Interactive report</p>",
              },
              { type: "custom_chart", values: [1, 2, 3] },
            ],
          },
        ],
      }),
      "json",
    ).messages[0];
    expect(source.assets?.map((asset) => asset.kind)).toEqual([
      "image",
      "audio",
      "video",
      "file",
    ]);
    expect(source.assets?.[0].data).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(source.assets?.[1]).toMatchObject({
      name: "Voice",
      url: "https://example.com/voice.mp3",
    });
    expect(source.content).toContain("| Road | 42 |");
    expect(source.content).toContain("$$\nx^2\n$$");
    expect(source.content).toContain(
      "```html-preview\n<p>Interactive report</p>",
    );
    expect(source.content).toContain('"custom_chart"');
    expect(source.content).toContain('"values"');
    expect(source.content.indexOf("#asset-0")).toBeLessThan(
      source.content.indexOf("#asset-3"),
    );
  });

  it("resolves shared ChatGPT image and citation references using exposed metadata", () => {
    const tag = '<AsyncImage ref="turn1image0"/>';
    const content = `Diagram:\n\n${tag}\n\nEvidence. <Cite ref="turn1search0"/>`;
    const source = importTranscript(
      JSON.stringify({
        messages: [
          {
            role: "assistant",
            content,
            metadata: {
              search_result_groups: [
                {
                  entries: [
                    {
                      ref_id: {
                        turn_index: 1,
                        ref_type: "search",
                        ref_index: 0,
                      },
                      title: "Official source",
                      url: "https://example.com/guide",
                    },
                  ],
                },
              ],
              genui_components: [
                {
                  type: "async_image",
                  start_index: content.indexOf(tag),
                  end_index: content.indexOf(tag) + tag.length,
                  safe_urls: [
                    { url: "https://example.com/page" },
                    {
                      url: "https://images.openai.com/static-rsc-4/example?purpose=fullsize",
                    },
                  ],
                  entities: [{ entity_type: "image", ref: "turn1image0" }],
                },
              ],
            },
          },
        ],
      }),
      "json",
    ).messages[0];
    expect(source.assets?.[0]).toMatchObject({
      kind: "image",
      ref: "turn1image0",
      url: "https://images.openai.com/static-rsc-4/example?purpose=fullsize",
    });
    const text = normalizeProviderText(source.content, source);
    expect(text).toContain("![Conversation image](#asset-0)");
    expect(text).toContain("[Official source](<https://example.com/guide>)");
    expect(text).not.toContain("turn1search0");
  });

  it("keeps unavailable opaque attachment references explicit without inventing URLs", () => {
    const source = importTranscript(
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              {
                content_type: "image_asset_pointer",
                asset_pointer: "file-service://private-id",
              },
            ],
          },
        ],
      }),
      "json",
    ).messages[0];
    expect(source.assets).toMatchObject([{ kind: "image" }]);
    expect(source.assets?.[0].url).toBeUndefined();
    expect(source.content).toContain("#asset-0");
  });

  it("renders bounded SVG coordinate loops without evaluating JavaScript", () => {
    const literal =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.road { fill: red; }</style><text>{literal label}</text><rect class="road" width="10" height="10"/></svg>';
    expect(prepareSvg(literal)).toBe(literal);
    const svg = prepareSvg(
      '<svg xmlns="http://www.w3.org/2000/svg">{#each [0,1,2] as i}<rect x={7+i*109} width="10"/><text fontSize="12">{["Before","During","After"][i]}</text>{/each}</svg>',
    );
    expect(svg).toContain('x="7"');
    expect(svg).toContain('x="225"');
    expect(svg).toContain('font-size="12"');
    expect(svg).toContain(">After</text>");
    expect(svg).not.toContain("#each");
    expect(() =>
      prepareSvg(
        '<svg><rect x={globalThis.fetch("https://example.com")}/></svg>',
      ),
    ).toThrow(/diagram/i);
  });
});
