import {
  citationSchema,
  object,
  text,
  type ConversationCitation,
} from "./schema";

/** Retain visible citation locations, without exposing encrypted citation tokens. */
export function citationLinks(
  block: Record<string, unknown>,
  citations: ConversationCitation[],
): string {
  const values = [
    ...(Array.isArray(block.annotations) ? block.annotations : []),
    ...(Array.isArray(block.citations) ? block.citations : []),
  ];
  const links: string[] = [];
  for (const value of values) {
    const annotation = object(value);
    if (!annotation) continue;
    const location = object(annotation.url_citation) ?? annotation;
    const url = text(location.url ?? location.uri);
    const existing = citations.find((citation) => citation.url === url);
    const parsed = citationSchema.safeParse({
      ref: text(location.ref ?? location.id) || `source-${citations.length}`,
      title: text(location.title) || url,
      url,
    });
    if (!parsed.success) continue;
    const citation = existing ?? parsed.data;
    if (!existing) citations.push(citation);
    const label = citation.title.replace(/[\[\]\\<>\r\n]/g, " ");
    const href = new URL(citation.url).href;
    const link = `[${label}](<${href}>)`;
    if (!links.includes(link)) links.push(link);
  }
  return links.length ? `\n\n${links.join(" ")}` : "";
}
