import { object, text } from "./schema";
import { notebookText } from "./notebook";

export type NotebookPresentation = {
  kind:
    | "html"
    | "svg"
    | "image"
    | "latex"
    | "text"
    | "plotly"
    | "vega"
    | "vega-lite"
    | "geojson"
    | "widget"
    | "json";
  mime: string;
  value: unknown;
  metadata: Record<string, unknown>;
};

/** Select one declared representation while keeping the original bundle intact. */
export function notebookPresentation(output: unknown): NotebookPresentation {
  const record = object(output);
  const data = object(record?.data);
  if (!data) throw new Error("Notebook output is missing its MIME bundle.");
  const choices: Array<[string, NotebookPresentation["kind"]]> = [
    ["application/vnd.jupyter.widget-view+json", "widget"],
    ["application/vnd.plotly.v1+json", "plotly"],
    ["text/html", "html"],
    ["image/svg+xml", "svg"],
    ["image/png", "image"],
    ["image/jpeg", "image"],
    ["image/webp", "image"],
    ["text/latex", "latex"],
    ["application/geo+json", "geojson"],
    ["application/vnd.geo+json", "geojson"],
    ["text/plain", "text"],
    ["application/json", "json"],
  ];
  for (const mime of Object.keys(data)) {
    if (/^application\/vnd\.vegalite\.v\d+\+json$/.test(mime))
      choices.unshift([mime, "vega-lite"]);
    else if (/^application\/vnd\.vega\.v\d+\+json$/.test(mime))
      choices.unshift([mime, "vega"]);
  }
  const choice = choices.find(([mime]) => Object.hasOwn(data, mime));
  if (!choice)
    throw new Error(
      `No supported display representation. Included types: ${Object.keys(data).join(", ") || "none"}.`,
    );
  const [mime, kind] = choice;
  const raw = data[mime];
  const value = ["html", "svg", "image", "latex", "text"].includes(kind)
    ? notebookText(raw)
    : raw;
  return { kind, mime, value, metadata: object(record?.metadata) ?? {} };
}

export function previewKind(mime: string): string | null {
  if (
    /^(application\/vnd\.ant\.react|text\/(jsx|tsx)|application\/(jsx|tsx))$/.test(
      mime,
    )
  )
    return "react-preview";
  if (/^(text\/html;profile=mcp-app|text\/html\+skybridge)$/.test(mime))
    return "mcp-preview";
  return null;
}

export function chartMime(block: Record<string, unknown>): string | null {
  const mime = text(block.mime_type ?? block.mimeType);
  if (
    /^application\/(vnd\.(plotly\.v1|vega(?:lite)?\.v\d+)\+json|(?:vnd\.)?geo\+json)$/.test(
      mime,
    )
  )
    return mime;
  const type = text(block.type);
  return type === "plotly"
    ? "application/vnd.plotly.v1+json"
    : type === "vega"
      ? "application/vnd.vega.v6+json"
      : type === "vega-lite"
        ? "application/vnd.vegalite.v6+json"
        : type === "geojson"
          ? "application/geo+json"
          : null;
}
