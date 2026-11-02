import { Parser } from "htmlparser2";
import { markdownRanges } from "@/lib/chat/normalize-math";
import { fenceCode } from "@/lib/chat/format/fence";
import { hiddenContent } from "../formats/visibility";
import { registerCardImages } from "../formats/media";
import { citationLinks } from "../formats/citations";
import type {
  ConversationAsset,
  ConversationCitation,
} from "../formats/schema";
import {
  boundedSnapshot,
  object,
  text,
  list,
  label,
  type WidgetKind,
  type WidgetSnapshot,
} from "./schema";

const names: Record<string, WidgetKind> = {
  WeatherWidget: "weather",
  WeatherWidgetV2: "weather",
  WeatherWidgetV3: "weather",
  WeatherWidgetWithSource: "weather",
  WeatherWidgetV3WithSource: "weather",
  "WeatherWidget.V2": "weather",
  "WeatherWidget.V3": "weather",
  StockQuoteWidget: "finance",
  StockChart: "finance",
  CurrencyConverter: "currency",
  CurrencyConverterWidget: "currency",
  CurrencyConverterWidgetWithSource: "currency",
  CurrencyConverterV2Widget: "currency",
  CurrencyConverterV2WidgetWithSource: "currency",
  MapWidget: "map",
  BusinessesMap: "map",
  PlacesMap: "map",
  NbaSchedule: "sports",
  NflSchedule: "sports",
  NbaScheduleWidget: "sports",
  NflScheduleWidget: "sports",
  NbaGamesSchedule: "sports",
  NflGamesSchedule: "sports",
};

function kind(name: string): WidgetKind | undefined {
  if (Object.hasOwn(names, name)) return names[name];
  if (/^(Nba|Nfl)[A-Za-z]*Schedule(?:Widget)?(?:WithSource)?$/.test(name))
    return "sports";
  return undefined;
}

function visible(value: unknown, depth = 0): unknown {
  if (depth > 30)
    throw new Error("Widget exceeds the display structure limit.");
  if (Array.isArray(value))
    return value
      .map((entry) => visible(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  const record = object(value);
  if (!record) return value;
  if (hiddenContent(record)) return undefined;
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key]) => !["__proto__", "prototype", "constructor"].includes(key),
      )
      .flatMap(([key, entry]) => {
        const cleaned = visible(entry, depth + 1);
        return cleaned === undefined ? [] : [[key, cleaned]];
      }),
  );
}

function snapshot(component: string, supplied: unknown): WidgetSnapshot | null {
  const type = kind(component);
  if (!type) return null;
  const state = object(supplied) ?? {};
  if (hiddenContent(state)) return null;
  const value = { kind: type, component, state };
  boundedSnapshot(value);
  return boundedSnapshot(value);
}

function preview(
  value: WidgetSnapshot,
  assets: ConversationAsset[],
  source?: string,
): string {
  const cleaned = boundedSnapshot(visible(value));
  const retained =
    source && JSON.stringify(value) === JSON.stringify(cleaned)
      ? { ...cleaned, source }
      : cleaned;
  boundedSnapshot(retained);
  value = cleaned;
  if (value.kind === "gallery") {
    const images = list(value.state.images, 100).map(
      (entry) => object(object(entry)?.image_result) ?? object(entry),
    );
    registerCardImages(
      {
        type: "AdaptiveCard",
        body: images.map((image) => ({
          type: "Image",
          url: image?.content_url ?? image?.thumbnail_url,
          altText: text(image?.title) || "Shared image",
        })),
      },
      assets,
    );
  }
  if (assets.length > 100)
    throw new Error("Imported message exceeds the 100-attachment limit.");
  return fenceCode(JSON.stringify(retained), "widget-preview");
}

export function importedWidget(
  block: Record<string, unknown>,
  assets: ConversationAsset[],
): string | null {
  if (hiddenContent(block)) return null;
  const declared = text(block.type ?? block.content_type);
  const component = text(block.component ?? block.name) || declared;
  const props = object(block.props);
  const value = snapshot(
    component,
    props?.__state ?? block.__state ?? block.state,
  );
  return value
    ? preview(value, assets)
    : declared === "widget"
      ? preview(
          {
            kind: "unsupported",
            component,
            state: object(props?.__state ?? block.__state ?? block.state) ?? {},
          },
          assets,
        )
      : null;
}

function referenceSnapshot(
  reference: Record<string, unknown>,
): WidgetSnapshot | null {
  if (reference.type === "image_group" || reference.type === "image_v2")
    return boundedSnapshot({
      kind: "gallery",
      state: {
        title: text(reference.title),
        images: list(reference.images, 100),
      },
    });
  if (reference.type === "nav_list")
    return boundedSnapshot({
      kind: "search",
      state: {
        title: text(reference.title),
        items: list(reference.items ?? reference.fallback_items, 100),
      },
    });
  const data = object(reference.data);
  const aliases: Record<string, WidgetKind> = {
    weather: "weather",
    forecast: "weather",
    finance: "finance",
    sports: "sports",
    map: "map",
    maps: "map",
  };
  if (
    typeof reference.type === "string" &&
    Object.hasOwn(aliases, reference.type)
  )
    return boundedSnapshot({
      kind: aliases[reference.type],
      component: reference.type,
      state:
        object(reference.__state ?? reference.state ?? data?.content) ?? {},
    });
  if (reference.type !== "client_defined_widget" || !data) return null;
  if (data.widget_type === "charts_widget_v2" && object(data.content))
    return boundedSnapshot({ kind: "chart", state: object(data.content) });
  const payload = object(data.content);
  const props = object(payload?.props);
  if (
    data.widget_type === "math_block_widget_always_prefetch_v2" ||
    data.widget_type === "code_block"
  )
    return null;
  return (
    snapshot(
      text(data.widget_type),
      props?.__state ?? payload?.__state ?? payload?.state ?? payload,
    ) ??
    boundedSnapshot({
      kind: "unsupported",
      component: text(data.widget_type),
      state: payload ?? { content: data.content ?? null },
    })
  );
}

function stateFor(
  component: string,
  props: Record<string, unknown>,
  metadata: Record<string, unknown>,
): WidgetSnapshot | null {
  if (object(props.__state)) return snapshot(component, props.__state);
  const id = text(props.__resolutionId ?? props.key);
  const results = object(object(metadata.opGenui)?.componentResults);
  if (
    !id ||
    !results ||
    !Object.hasOwn(results, id) ||
    ["__proto__", "constructor", "prototype"].includes(id)
  )
    return snapshot(component, {});
  const result = object(results[id]);
  if (!result || hiddenContent(result)) return snapshot(component, {});
  return snapshot(
    component,
    result.__state ?? object(result.props)?.__state ?? result.state ?? result,
  );
}

interface Edit {
  start: number;
  end: number;
  content: string;
  available: boolean;
}

/** Match only the component's own literal JSON, never JavaScript expressions. */
function stateAttribute(
  tag: string,
  attributes: Record<string, string>,
): unknown {
  if (attributes.__state) {
    try {
      return JSON.parse(attributes.__state) as unknown;
    } catch {
      /* JSX JSON is decoded below. */
    }
  }
  const match = /\b__state\s*=\s*\{/.exec(tag);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  let depth = 1,
    quoted = false,
    escaped = false;
  for (let index = start; index < tag.length; index++) {
    const character = tag[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") {
      if (++depth > 30) return undefined;
    } else if (character === "}" && --depth === 0) {
      try {
        return JSON.parse(tag.slice(start, index)) as unknown;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Scan tag boundaries while respecting JSON strings and JSX braces. */
function tagEnd(content: string, start: number): number {
  let quote = "",
    escaped = false,
    depth = 0;
  for (let index = start; index < content.length; index++) {
    const character = content[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "{") {
      if (++depth > 30) return -1;
    } else if (character === "}") depth--;
    else if (character === ">" && depth === 0) return index + 1;
  }
  return -1;
}

function closingTag(
  content: string,
  end: number,
  name: string,
  editable: (start: number, end: number) => boolean,
): [number, number] | null {
  const pattern = new RegExp(
    `<(/?)${name.replaceAll(".", "\\.")}(?=[\\s/>])`,
    "g",
  );
  pattern.lastIndex = end;
  let depth = 1;
  for (
    let match = pattern.exec(content);
    match;
    match = pattern.exec(content)
  ) {
    const boundary = tagEnd(content, match.index);
    if (boundary < 0 || !editable(match.index, boundary)) continue;
    if (!match[1] && /\/\s*>$/.test(content.slice(match.index, boundary)))
      continue;
    depth += match[1] ? -1 : 1;
    if (depth === 0) return [match.index, boundary];
  }
  return null;
}

export function widgetMetadata(
  content: string,
  value: unknown,
  assets: ConversationAsset[],
  citations: ConversationCitation[],
): string {
  const metadata = object(value) ?? {};
  const references = list(metadata.content_references, 1000);
  const components = list(metadata.genui_components, 1000);
  const fallback = text(object(metadata.model_dil_v2)?.fallbackMarkdown);
  if (
    !references.length &&
    !components.length &&
    !fallback &&
    !/<(?:WeatherWidget|StockQuoteWidget|StockChart|CurrencyConverter|MapWidget|BusinessesMap|PlacesMap|Nba|Nfl)|\bdata-assistant-(?:map|businesses-map|entity|entity-metadata)-payload/.test(
      content,
    )
  )
    return content;
  const literal = markdownRanges(content, new Set(["code", "inlineCode"]));
  const editable = (start: number, end: number) =>
    !literal.some((range) => start < range.end && end > range.start);
  const edits: Edit[] = [];
  const footnotes: Record<string, unknown>[] = [];
  let projected = content.length;
  function add(
    start: number,
    end: number,
    replacement: string,
    available = true,
  ) {
    if (
      start < 0 ||
      end > content.length ||
      start >= end ||
      !editable(start, end) ||
      edits.some((edit) => start < edit.end && end > edit.start)
    )
      return;
    projected += replacement.length - (end - start);
    if (projected > 500_000)
      throw new Error("Rendered widget content exceeds the message limit.");
    edits.push({ start, end, content: replacement, available });
  }
  for (const entry of components) {
    const component = object(entry);
    if (!component || hiddenContent(component)) continue;
    const start = component.start_index;
    const end = component.end_index;
    if (
      typeof start !== "number" ||
      !Number.isInteger(start) ||
      typeof end !== "number" ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > content.length ||
      start >= end ||
      !editable(start, end)
    )
      continue;
    const name = text(component.type);
    const source = content.slice(start, end);
    if (
      !kind(name) ||
      !source.startsWith(`<${name}`) ||
      !/[\s/>]/.test(source[name.length + 1] ?? "")
    )
      continue;
    const props = object(component.props);
    if (!props || hiddenContent(props)) continue;
    const widget = stateFor(name, props, metadata);
    if (widget) {
      add(
        start,
        end,
        `\n\n${preview(widget, assets, source)}\n\n`,
        Object.keys(widget.state).length > 0,
      );
    }
  }
  for (const entry of references) {
    const reference = object(entry);
    if (!reference || hiddenContent(reference)) continue;
    if (reference.type === "sources_footnote") {
      for (const source of list(reference.sources, 100)) {
        const record = object(source);
        if (record && !hiddenContent(record)) footnotes.push(record);
      }
      if (footnotes.length > 100)
        throw new Error("Widget exceeds the display row limit.");
    }
    const marker = text(reference.matched_text);
    if (!marker) continue;
    let start =
      typeof reference.start_idx === "number" &&
      Number.isInteger(reference.start_idx)
        ? reference.start_idx
        : -1;
    if (
      start < 0 ||
      content.slice(start, start + marker.length) !== marker ||
      !editable(start, start + marker.length)
    ) {
      const matches: number[] = [];
      for (
        let index = content.indexOf(marker);
        index >= 0;
        index = content.indexOf(marker, index + marker.length)
      ) {
        if (editable(index, index + marker.length)) matches.push(index);
        if (matches.length > 1) break;
      }
      if (matches.length !== 1) continue;
      start = matches[0];
    }
    if (!editable(start, start + marker.length)) continue;
    const widget = referenceSnapshot(reference);
    if (widget) {
      add(
        start,
        start + marker.length,
        `\n\n${preview(widget, assets, marker)}\n\n`,
        Object.keys(widget.state).length > 0,
      );
      continue;
    }
    const data = object(reference.data);
    if (
      (data?.widget_type === "math_block_widget_always_prefetch_v2" &&
        typeof data.content === "string") ||
      (reference.type === "alt_text" &&
        reference.render_as === "latex" &&
        typeof reference.alt === "string")
    ) {
      const latex =
        typeof data?.content === "string" ? data.content : text(reference.alt);
      add(start, start + marker.length, `\n\n$$\n${latex}\n$$\n\n`);
      continue;
    }
    if (data?.widget_type === "code_block") continue;
    if (marker.startsWith("\uE200entity\uE202")) {
      try {
        const entity: unknown = JSON.parse(marker.slice(8, -1));
        if (Array.isArray(entity) && typeof entity[1] === "string")
          add(start, start + marker.length, label(entity[1]));
      } catch {
        /* Preserve malformed source. */
      }
      continue;
    }
    const sources = list(reference.items ?? reference.fallback_items, 1000);
    const links = citationLinks(
      {
        citations: sources.length ? sources : reference.url ? [reference] : [],
      },
      citations,
    ).trim();
    if (links) add(start, start + marker.length, links);
    else if (
      typeof reference.alt === "string" &&
      reference.alt.trim() &&
      reference.type !== "hidden"
    )
      add(start, start + marker.length, reference.alt);
  }
  for (const match of content.matchAll(
    /<([A-Z][A-Za-z0-9.]*)\b|<([a-z][\w-]*)\b(?=[^\n]*\bdata-assistant-(?:map|businesses-map|entity|entity-metadata)-payload)/g,
  )) {
    if (edits.length > 1000)
      throw new Error("Message exceeds the widget reference limit.");
    const component = match[1] ?? match[2];
    if (match[1] && !kind(component)) continue;
    if (
      !editable(match.index, match.index + match[0].length) ||
      edits.some((edit) => match.index >= edit.start && match.index < edit.end)
    )
      continue;
    const end = tagEnd(content, match.index);
    if (end < 0)
      throw new Error("The provider returned an incomplete widget tag.");
    if (
      !editable(match.index, end) ||
      edits.some((edit) => match.index < edit.end && end > edit.start)
    )
      continue;
    const tag = content.slice(match.index, end);
    let attributes: Record<string, string> = {};
    const parser = new Parser(
      {
        onopentag(_name, values) {
          attributes = values;
        },
      },
      { xmlMode: true, decodeEntities: true },
    );
    parser.end(tag);
    let widget: WidgetSnapshot | null = null;
    if (match[1])
      widget = stateFor(
        component,
        { ...attributes, __state: stateAttribute(tag, attributes) },
        metadata,
      );
    else {
      const key = Object.keys(attributes).find((key) =>
        /^data-assistant-(map|businesses-map|entity|entity-metadata)-payload$/.test(
          key,
        ),
      );
      if (key)
        try {
          const data: unknown = JSON.parse(attributes[key]);
          const record = object(data);
          const places = Array.isArray(data)
            ? data
            : [record?.entity_data ?? record?.entityData];
          widget = boundedSnapshot({
            kind: "map",
            component,
            state: { places },
          });
        } catch {
          widget = boundedSnapshot({ kind: "map", component, state: {} });
        }
    }
    if (widget) {
      add(
        match.index,
        end,
        `\n\n${preview(widget, assets, tag)}\n\n`,
        Object.keys(widget.state).length > 0,
      );
      if (!/\/\s*>$/.test(tag)) {
        const close = closingTag(content, end, component, editable);
        if (close) add(close[0], close[1], "");
      }
    }
  }
  let result = "",
    cursor = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    result += content.slice(cursor, edit.start) + edit.content;
    cursor = edit.end;
  }
  result += content.slice(cursor);
  let sources = "";
  if (footnotes.length) {
    const publicCitations: ConversationCitation[] = [];
    citationLinks({ citations: footnotes }, publicCitations);
    citationLinks({ citations: publicCitations }, citations);
    if (publicCitations.length)
      sources = `\n\n${preview({ kind: "search", state: { title: "Sources", items: publicCitations.map(({ title, url }) => ({ title, url })) } }, assets)}\n\n`;
  }
  if (
    fallback &&
    (!content.trim() || (edits.length && !edits.some((edit) => edit.available)))
  ) {
    const retained = [fallback, result, sources].join("\n\n");
    if (retained.length > 500_000)
      throw new Error("Rendered widget content exceeds the message limit.");
    return retained;
  }
  if (result.length + sources.length > 500_000)
    throw new Error("Rendered widget content exceeds the message limit.");
  return result + sources;
}
