/** Remove provider citation control markers that are not valid Markdown. */
export function normalizeProviderText(content: string): string {
  return content
    .replace(/\uE200cite\uE202[\w:-]+(?:\uE202[\w:-]+)*\uE201/g, "")
    .replace(/[\uE200\uE201\uE202]/g, "");
}
