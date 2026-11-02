import type { ConversationAsset } from "../formats/schema";
import {
  boundedSnapshot,
  object,
  text,
  list,
  label,
  link,
  scalar,
  table,
} from "./schema";
import { weatherMarkdown } from "./forecast";
import { financeMarkdown, sportsMarkdown } from "./markets";
import { chartMarkdown, mapMarkdown } from "./plot";

/** Native saved views use supplied display state, never host services or provider code. */
function renderWidget(
  value: unknown,
  assets: ConversationAsset[] = [],
): string {
  const { kind, state, component } = boundedSnapshot(value);
  if (kind === "unsupported")
    return `This saved widget (${label(component) || "unknown type"}) uses an unsupported display format. Its source is available below.`;
  if (kind === "weather") return weatherMarkdown(state);
  if (kind === "finance") return financeMarkdown(state);
  if (kind === "sports") return sportsMarkdown(state);
  if (kind === "chart") return chartMarkdown(state);
  if (kind === "map") return mapMarkdown(state);
  if (kind === "currency")
    return `### Saved conversion\n\n${table(["Amount", "From", "To", "Exchange rate"], [[scalar(state.base_amount), scalar(state.from_currency), scalar(state.to_currency), scalar(state.exchange_rate)]])}`;
  const entries = list(kind === "gallery" ? state.images : state.items, 100);
  const cards = entries
    .map((value) => {
      const entry = object(object(value)?.image_result) ?? object(value);
      if (!entry) return "";
      const url = text(entry.content_url ?? entry.thumbnail_url);
      const index = assets.findIndex(
        (asset) =>
          asset.kind === "image" && (asset.url === url || asset.data === url),
      );
      const image =
        kind === "gallery"
          ? index >= 0
            ? `![${label(entry.title) || "Shared image"}](#asset-${index})`
            : "Image was not included in this share."
          : "";
      return `<grid-item>\n${[image, link(entry.title ?? entry.name, entry.url), label(entry.snippet ?? entry.description)].filter(Boolean).join("\n\n")}\n</grid-item>`;
    })
    .filter(Boolean);
  return cards.length
    ? `### ${label(state.title) || (kind === "gallery" ? "Image gallery" : "Search results")}\n\n<grid columns={${kind === "gallery" ? 3 : 2}}>\n${cards.join("\n")}\n</grid>`
    : "The provider did not include this widget's results. The saved source is available below.";
}

export function widgetMarkdown(
  value: unknown,
  assets: ConversationAsset[] = [],
): string {
  const markdown = renderWidget(value, assets);
  if (markdown.length > 500_000)
    throw new Error("Rendered widget exceeds the message display limit.");
  return markdown;
}
