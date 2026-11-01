import { fenceCode } from "@/lib/chat/format/code";
import { formatTableCell } from "@/lib/chat/format/table";
import { object, text, type ConversationAsset } from "./schema";

export function displayChildren(value: Record<string, unknown>): unknown[] {
  const children =
    value.body ??
    value.items ??
    value.columns ??
    value.images ??
    value.rows ??
    value.cells;
  return Array.isArray(children) ? children : [];
}

/** Native card display uses the existing safe Markdown and layout renderer. */
export function cardMarkdown(
  card: unknown,
  assets: ConversationAsset[] = [],
  includeActions = true,
): string {
  if (object(card)?.type !== "AdaptiveCard")
    throw new Error("Invalid Adaptive Card.");
  let count = 0;
  function render(value: unknown, depth = 0): string {
    if (++count > 2000 || depth > 30)
      throw new Error("Card exceeds the display limit.");
    const node = object(value);
    if (!node) return "";
    const type = text(node.type);
    if (type === "TextBlock") return text(node.text);
    if (type === "RichTextBlock")
      return (Array.isArray(node.inlines) ? node.inlines : [])
        .map((inline) =>
          typeof inline === "string" ? inline : text(object(inline)?.text),
        )
        .join("");
    if (type === "Image") {
      const index = assets.findIndex(
        (asset) =>
          asset.kind === "image" &&
          (asset.url === node.url || asset.data === node.url),
      );
      return index >= 0
        ? `![${text(node.altText).replace(/[\[\]\\]/g, "") || "Card image"}](#asset-${index})`
        : "Image unavailable in this saved card.";
    }
    if (type === "FactSet") {
      const rows = (Array.isArray(node.facts) ? node.facts : []).map((fact) => {
        const entry = object(fact);
        return `| ${formatTableCell(text(entry?.title))} | ${formatTableCell(text(entry?.value))} |`;
      });
      return ["| Fact | Value |", "| --- | --- |", ...rows].join("\n");
    }
    if (type === "Table") {
      const rows = displayChildren(node).map((row) =>
        displayChildren(object(row) ?? {}).map((cell) =>
          formatTableCell(
            displayChildren(object(cell) ?? {})
              .map((item) => render(item, depth + 3))
              .join(" "),
          ),
        ),
      );
      if (!rows.length) return "";
      return [rows[0], rows[0].map(() => "---"), ...rows.slice(1)]
        .map((row) => `| ${row.join(" | ")} |`)
        .join("\n");
    }
    if (type.startsWith("Input."))
      return `${text(node.label ?? node.id)}: ${String(node.value ?? "")}`;
    if (type === "ActionSet")
      return (Array.isArray(node.actions) ? node.actions : [])
        .map((action) => render(action, depth + 1))
        .join("\n\n");
    if (type.startsWith("Action."))
      return `${text(node.title) || type} (saved action; account access is unavailable)${type === "Action.OpenUrl" ? `\n\n${text(node.url)}` : ""}`;
    if (type === "ColumnSet") {
      const columns = displayChildren(node);
      return `<grid columns={${Math.min(4, Math.max(1, columns.length))}}>\n${columns.map((column) => `<grid-item>\n${render(column, depth + 1)}\n</grid-item>`).join("\n")}\n</grid>`;
    }
    if (
      ["AdaptiveCard", "Container", "Column", "ImageSet", "TableCell"].includes(
        type,
      )
    )
      return displayChildren(node)
        .map((child) => render(child, depth + 1))
        .join("\n\n");
    return `Unsupported card element: ${type || "unknown"}.\n\n${fenceCode(JSON.stringify(node, null, 2), "json")}`;
  }
  const root = object(card)!;
  return [
    render(root),
    ...(includeActions && Array.isArray(root.actions)
      ? root.actions.map((action) => render(action, 1))
      : []),
    "Saved card. Account actions and submissions are unavailable.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
