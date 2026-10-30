import { Parser } from "htmlparser2";
import type { Element, Root, RootContent } from "hast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import { protectMarkdownCode } from "../format/code";
import { normalizeMath } from "../normalize-math";
import { normalizeProviderText } from "../normalize-provider-text";
import type { ShareMarkupContext } from "../normalize-share-markup";
import { layoutXml } from "./share-layout-source";
import { siteIconSite } from "./site-icon";

interface LayoutElement {
  name: string;
  attributes: Record<string, string>;
  children: (LayoutElement | string)[];
  start: number;
  end: number;
}

const markdown = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype);
const containers = new Set([
  "box",
  "grid",
  "grid-item",
  "row",
  "text",
  "caption",
  "title",
  "badge",
]);
const inline = new Set(["link", "entity", "cite", "memorycite", "asyncimage"]);

function element(
  tagName: string,
  children: Element["children"],
  properties: Element["properties"] = {},
): Element {
  return { type: "element", tagName, properties, children };
}

function number(
  value: string | undefined,
  maximum: number,
): string | undefined {
  const match = /^(?:\{(\d+)\}|(\d+))$/.exec(value ?? "");
  const result = match ? Number(match[1] ?? match[2]) : NaN;
  return Number.isInteger(result) && result >= 0 && result <= maximum
    ? String(result)
    : undefined;
}

function tone(value: string): string | undefined {
  if (/^surface-(secondary|tertiary)$/.test(value)) return "surface";
  if (/^(secondary|tertiary|success|warning|danger)$/.test(value)) return value;
  const rgb =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:0?\.\d+|[01]))?\s*\)$/.exec(
      value,
    );
  const hex = /^#([\da-f]{6})$/i.exec(value)?.[1];
  const components = rgb
    ? rgb.slice(1, 4).map(Number)
    : hex
      ? [0, 2, 4].map((start) => parseInt(hex.slice(start, start + 2), 16))
      : null;
  if (!components || components.some((value) => value > 255)) return undefined;
  const [red, green, blue] = components;
  return blue >= red && blue >= green
    ? "blue"
    : red > green
      ? "orange"
      : "green";
}

function properties(node: LayoutElement): Element["properties"] {
  const attrs = node.attributes;
  const result: Element["properties"] = { dataShareLayout: node.name };
  const allowed: Record<string, string[]> = {
    radius: ["2xs", "xs", "sm", "md", "lg", "xl"],
    align: ["start", "center", "end", "stretch"],
    justify: ["start", "center", "end", "between", "around"],
    textalign: ["start", "left", "center", "end", "right"],
    weight: ["normal", "medium", "semibold", "bold"],
    size: ["2xs", "xs", "sm", "md", "lg", "xl", "2xl"],
    wrap: ["wrap", "nowrap"],
  };
  for (const [name, values] of Object.entries(allowed)) {
    if (values.includes(attrs[name]))
      result[`data-share-${name}`] = attrs[name];
  }
  for (const name of ["padding", "gap", "columns", "flex"]) {
    const value = number(
      attrs[name],
      name === "columns" || name === "flex" ? 4 : 8,
    );
    if (value !== undefined) result[`data-share-${name}`] = value;
  }
  if (attrs.gap === "2px") result.dataShareGap = "tight";
  if (
    Object.hasOwn(attrs, "border") &&
    !/^(false|\{false\})$/.test(attrs.border)
  )
    result.dataShareBorder = "true";
  if (Object.hasOwn(attrs, "tabularnums")) result.dataShareTabular = "true";
  if (attrs.width === "100%") result.dataShareWidth = "full";
  if (attrs.size === "10px" && node.name === "box")
    result.dataShareSwatch = "true";
  const background = tone(attrs.background ?? "");
  const color = tone(attrs.color ?? "");
  if (background) result.dataShareBackground = background;
  if (color) result.dataShareColor = color;
  if (
    node.name === "row" &&
    node.children.some(
      (child) => typeof child !== "string" && child.name === "favicon",
    )
  )
    result.dataShareFaviconRow = "true";
  return result;
}

function favicon(node: LayoutElement): Element {
  const { origin = "", host = "" } =
    siteIconSite(node.attributes.url ?? "") ?? {};
  const size = /^(?:\{(\d+)\}|(\d+)(?:px)?)$/.exec(node.attributes.size ?? "");
  const pixels = size?.[1] ?? size?.[2] ?? "24";
  return element("span", [{ type: "text", value: "◉" }], {
    dataShareFavicon: origin,
    dataShareFaviconHost: host,
    dataShareFaviconSize: ["16", "24", "32"].includes(pixels) ? pixels : "24",
    role: "img",
    ariaLabel: host ? `Site icon for ${host}` : "Site icon unavailable",
  });
}

function layout(source: string, context: ShareMarkupContext): Element[] {
  if (source.length > 500_000)
    throw new Error("Shared layout exceeds the preview limit.");
  const code = protectMarkdownCode(source);
  const input = layoutXml(code.text);
  const balance: string[] = [];
  let tags = 0;
  for (const match of input.matchAll(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?([A-Za-z][\w:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/g,
  )) {
    if (!match[1]) continue;
    if (++tags > 4000)
      throw new Error("Shared layout is too complex to display.");
    const name = match[1].toLowerCase();
    if (match[0].startsWith("</")) {
      if (balance.pop() !== name)
        throw new Error("Shared layout has unbalanced tags.");
    } else if (!match[0].endsWith("/>")) {
      balance.push(name);
      if (balance.length > 32)
        throw new Error("Shared layout is too complex to display.");
    }
  }
  if (balance.length) throw new Error("Shared layout has unbalanced tags.");
  const root: LayoutElement = {
    name: "root",
    attributes: {},
    children: [],
    start: 0,
    end: input.length,
  };
  const stack = [root];
  let count = 0;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (++count > 2000 || stack.length > 32)
          throw new Error("Shared layout is too complex to display.");
        const node: LayoutElement = {
          name: name.toLowerCase(),
          attributes: Object.fromEntries(
            Object.entries(attributes).map(([name, value]) => [
              name.toLowerCase(),
              value,
            ]),
          ),
          children: [],
          start: parser.startIndex,
          end: parser.endIndex + 1,
        };
        stack.at(-1)!.children.push(node);
        stack.push(node);
      },
      ontext(text) {
        if (++count > 4000)
          throw new Error("Shared layout is too complex to display.");
        stack.at(-1)!.children.push(text);
      },
      onclosetag(name, implied) {
        const node = stack.pop();
        if (
          !node ||
          node === root ||
          node.name !== name.toLowerCase() ||
          (implied &&
            !input.slice(parser.startIndex, parser.endIndex + 1).endsWith("/>"))
        )
          throw new Error("Shared layout has unbalanced tags.");
        node.end = parser.endIndex + 1;
      },
    },
    { xmlMode: true, decodeEntities: false },
  );
  parser.end(input);
  if (stack.length !== 1) throw new Error("Shared layout has unbalanced tags.");
  function text(value: string): Element["children"] {
    const lines = code.restore(value).split("\n");
    const indentation = lines.reduce(
      (minimum, line) =>
        line.trim() ? Math.min(minimum, /^ */.exec(line)![0].length) : minimum,
      Infinity,
    );
    const dedented = lines
      .map((line) =>
        line.slice(Math.min(indentation, /^ */.exec(line)![0].length)),
      )
      .join("\n")
      .trim();
    const content = normalizeMath(normalizeProviderText(dedented, context));
    return markdown
      .runSync(markdown.parse(content))
      .children.filter(
        (node): node is Element | Extract<RootContent, { type: "text" }> =>
          node.type === "element" || node.type === "text",
      );
  }
  function children(node: LayoutElement): Element["children"] {
    const output: Element["children"] = [];
    let buffer = "";
    const flush = () => {
      if (buffer.trim()) output.push(...text(buffer));
      buffer = "";
    };
    for (const child of node.children) {
      if (typeof child === "string") {
        buffer += child;
        continue;
      }
      const original = input.slice(child.start, child.end);
      if (inline.has(child.name)) {
        buffer += original;
        continue;
      }
      if (child.name === "br") {
        buffer += "\n";
        continue;
      }
      flush();
      if (containers.has(child.name)) {
        output.push(element("div", children(child), properties(child)));
      } else if (child.name === "favicon") {
        output.push(favicon(child));
      } else if (child.name === "icon") {
        const name = child.attributes.name ?? "";
        const symbol =
          name === "arrow-down"
            ? "↓"
            : name === "arrow-right"
              ? "→"
              : name === "check-circle"
                ? "✓"
                : "•";
        output.push(
          element("span", [{ type: "text", value: symbol }], {
            dataShareIcon: /^[a-z-]{1,40}$/.test(name) ? name : "unknown",
            ariaHidden: "true",
          }),
        );
      } else if (child.name === "divider") {
        output.push(element("hr", []));
      } else if (child.name === "svg" || child.name === "table") {
        output.push(...text(original));
      } else {
        output.push(
          element("pre", [
            element("code", [{ type: "text", value: code.restore(original) }]),
          ]),
        );
      }
    }
    flush();
    return output;
  }
  return [element("div", children(root), { dataShareDocument: "true" })];
}

/** Expand only our provider-layout fences. Imported attributes never become DOM props. */
export function rehypeShareLayouts(context: ShareMarkupContext = {}) {
  return (tree: Root): void => {
    function visit(parent: Root | Element): void {
      const result = (parent.children as RootContent[]).flatMap<RootContent>(
        (child) => {
          if (child.type !== "element") return [child];
          const code = child.children[0];
          if (
            child.tagName === "pre" &&
            code?.type === "element" &&
            Array.isArray(code.properties.className) &&
            code.properties.className.includes("language-share-layout")
          ) {
            const source = code.children
              .map((node) => (node.type === "text" ? node.value : ""))
              .join("");
            try {
              return layout(source, context);
            } catch (error) {
              return [
                element("div", [
                  element(
                    "p",
                    [
                      {
                        type: "text",
                        value:
                          error instanceof Error
                            ? error.message
                            : "Shared layout could not be displayed.",
                      },
                    ],
                    { role: "alert" },
                  ),
                  child,
                ]),
              ];
            }
          }
          visit(child);
          return [child];
        },
      );
      parent.children =
        parent.type === "root"
          ? result
          : result.filter((node) => node.type !== "doctype");
    }
    visit(tree);
  };
}
