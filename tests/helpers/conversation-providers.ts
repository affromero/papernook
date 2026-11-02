// Shapes verified against anonymous public-share responses, not provider API chat completions.
export const geminiShareId = "0123456789ab";
export const grokShareId = "bGVnYWN5_00000000-0000-0000-0000-000000000001";
export const perplexityShareId = "1f06f659-7315-4845-b6c3-be761b947b5f";

export function geminiShare(answer = "A visible answer with $x^2$.") {
  const candidate = [
    "candidate",
    [answer],
    null,
    { internal: "PRIVATE CANDIDATE STATE" },
  ];
  const turn = [
    ["turn"],
    null,
    [["A public question", null, null, null, []]],
    [[candidate]],
    [],
  ];
  const payload = [
    [
      null,
      [turn],
      [null, "Gemini example"],
      geminiShareId,
      { internal: "PRIVATE ROOT STATE" },
    ],
  ];
  return (
    ")]}'\n\n123\n" +
    JSON.stringify([["wrb.fr", "ujx1Bf", JSON.stringify(payload), null]]) +
    "\n"
  );
}

export function grokShare() {
  return {
    isPublic: true,
    conversation: { title: "Grok example", userId: "PRIVATE OWNER" },
    responses: [
      {
        sender: "human",
        partial: false,
        inputChunks: [{ text: { text: "A public question" } }],
      },
      {
        sender: "ASSISTANT",
        partial: false,
        isControl: true,
        message: "PRIVATE CONTROL",
      },
      { sender: "tool", partial: false, message: "PRIVATE TOOL" },
      {
        sender: "ASSISTANT",
        partial: false,
        outputChunks: [
          { text: { text: "PRIVATE REASONING", channel: "CHANNEL_THINKING" } },
          {
            text: {
              text: "A visible answer",
              channel: "CHANNEL_ASSISTANT_RESPONSE",
            },
          },
        ],
        generatedImageUrls: ["https://images.example/chart.png"],
        citedWebSearchResults: [
          { title: "Published source", url: "https://example.com/source" },
        ],
      },
    ],
  };
}

export function perplexityShare(legacy = false) {
  const answer = "A visible answer [1]. Literal `[1]` stays code.";
  const webResults = [
    {
      name: "Published source",
      url: "https://example.com/source",
      snippet: "PRIVATE UNUSED SNIPPET",
    },
  ];
  const entry = {
    thread_access: 2,
    privacy_state: "NONE",
    status: "COMPLETED",
    step_type: "FINAL",
    thread_url_slug: perplexityShareId,
    query_str: "A public question",
    author_id: "PRIVATE OWNER",
    read_write_token: "PRIVATE TOKEN",
    ...(legacy
      ? {
          text: JSON.stringify([
            { step_type: "RESEARCH", content: { answer: "PRIVATE REASONING" } },
            {
              step_type: "FINAL",
              content: {
                answer: JSON.stringify({ answer, web_results: webResults }),
              },
            },
          ]),
        }
      : {
          access_level: "PUBLIC_READ",
          blocks: [
            {
              intended_usage: "reasoning",
              markdown_block: { progress: "DONE", answer: "PRIVATE REASONING" },
            },
            {
              intended_usage: "ask_text",
              markdown_block: { progress: "DONE", answer },
            },
            {
              intended_usage: "web_results",
              web_result_block: { progress: "DONE", web_results: webResults },
            },
          ],
        }),
  };
  return {
    entries: [entry],
    background_entries: [{ query_str: "PRIVATE BACKGROUND" }],
    has_next_page: false,
    thread_metadata: {
      title: "Perplexity example",
      author_id: "PRIVATE OWNER",
    },
  };
}
