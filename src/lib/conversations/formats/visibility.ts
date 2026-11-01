import { object, text } from "./schema";

/** Apply the same visibility boundary to content parts and transcript envelopes. */
export function hiddenContent(value: Record<string, unknown>): boolean {
  const metadata = object(value.metadata);
  return (
    value.thought === true ||
    value.functionCall !== undefined ||
    value.functionResponse !== undefined ||
    metadata?.is_visually_hidden_from_conversation === true ||
    metadata?.is_redacted === true ||
    value.channel === "analysis" ||
    (typeof value.recipient === "string" && value.recipient !== "all") ||
    /^(thinking|redacted_thinking|redacted_reasoning|thoughts|reasoning|reasoning_recap|analysis|model_editable_context|tool_use|tool_result|tool_call|tool_request|tool_response|function_call|function_call_output)$/.test(
      text(value.type ?? value.content_type),
    )
  );
}
