/** Remove provider control markup that is not valid Markdown. */
export function normalizeProviderText(content: string): string {
  return (
    content
      // OpenAI's writing blocks are instructions for its own client. Keep the
      // authored body and discard the client-only wrapper and metadata.
      .replace(/:::writing(?:\{[^}\n]*\})?\s*/gi, "")
      .replace(/^:::\s*$/gm, "")
      .replace(/\uE200cite\uE202[\w:-]+(?:\uE202[\w:-]+)*\uE201/g, "")
      .replace(/[\uE200\uE201\uE202]/g, "")
      // Boxed text from imported LaTeX renders as border strokes through
      // adjacent text when several boxes share one display equation.
      .replace(/\\boxed\{\\text\{([^{}]*)\}\}/g, "\\text{$1}")
      // Some imported transcripts have already substituted the private-use
      // citation controls with visible square placeholders.
      .replace(/□(?:mem)?cite□/gi, "")
      .replace(/[\uFFFC]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
