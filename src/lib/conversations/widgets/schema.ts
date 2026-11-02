import { object, text, http } from "../formats/schema";
import { hiddenContent } from "../formats/visibility";
import {
  escapeMarkdownLabel,
  formatShareLink,
} from "@/lib/chat/normalize-share-markup";
import { formatTableCell } from "@/lib/chat/format/table";
export { object, text };

export type WidgetKind =
  | "gallery"
  | "search"
  | "chart"
  | "weather"
  | "finance"
  | "sports"
  | "map"
  | "currency"
  | "unsupported";
export interface WidgetSnapshot {
  kind: WidgetKind;
  state: Record<string, unknown>;
  component?: string;
}

export function list(value: unknown, limit = 500): unknown[] {
  if (!Array.isArray(value)) return [];
  if (value.length > limit)
    throw new Error("Widget exceeds the display row limit.");
  return value;
}
export function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function scalar(value: unknown): string {
  return typeof value === "string" ? value : finite(value) ? String(value) : "";
}
export function label(value: unknown): string {
  return escapeMarkdownLabel(scalar(value).replace(/[\r\n]/g, " ")).replaceAll(
    "$",
    "\\$",
  );
}
export function link(title: unknown, url: unknown): string {
  const href = http(url);
  return href
    ? formatShareLink(scalar(title) || new URL(href).hostname, href)
    : label(title);
}
export function table(columns: string[], rows: string[][]): string {
  return [columns, columns.map(() => "---"), ...rows]
    .map((row) => `| ${row.map(formatTableCell).join(" | ")} |`)
    .join("\n");
}
export function boundedSnapshot(value: unknown): WidgetSnapshot {
  const root = object(value);
  const kinds: WidgetKind[] = [
    "gallery",
    "search",
    "chart",
    "weather",
    "finance",
    "sports",
    "map",
    "currency",
    "unsupported",
  ];
  if (
    !root ||
    !kinds.includes(root.kind as WidgetKind) ||
    !object(root.state) ||
    hiddenContent(root) ||
    hiddenContent(object(root.state)!)
  )
    throw new Error("Unsupported saved widget state.");
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let count = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > 20_000 || current.depth > 30)
      throw new Error("Widget exceeds the display structure limit.");
    if (current.value && typeof current.value === "object")
      for (const entry of Object.values(current.value)) {
        if (pending.length + count >= 20_000)
          throw new Error("Widget exceeds the display structure limit.");
        pending.push({ value: entry, depth: current.depth + 1 });
      }
  }
  if (JSON.stringify(value).length > 300_000)
    throw new Error("Widget exceeds the display source limit.");
  return {
    kind: root.kind as WidgetKind,
    state: object(root.state)!,
    ...(typeof root.component === "string"
      ? { component: root.component }
      : {}),
  };
}
