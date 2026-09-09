import type { Element, Root } from "hast";

function headingLevel(node: Element): number | null {
  const match = /^h([1-6])$/.exec(node.tagName);
  return match ? Number(match[1]) : null;
}

function numberedSectionLevel(node: Element): number | null {
  const level = headingLevel(node);
  if (level !== null && /^\d+[.)]\s/.test(textContent(node))) return level;
  const first = node.children[0];
  if (
    node.tagName === "p" &&
    first?.type === "element" &&
    first.tagName === "strong" &&
    /^\d+[.)]\s/.test(textContent(node))
  ) {
    return 2;
  }
  return null;
}

function textContent(node: Element): string {
  return node.children
    .map((child) => {
      if (child.type === "text") return child.value;
      if (child.type === "element") return textContent(child);
      return "";
    })
    .join("");
}

/** Wrap numbered Markdown headings and their following section in a disclosure. */
export function rehypeCollapsibleNumberedSections() {
  return (tree: Root): void => {
    const output: Root["children"] = [];
    for (let index = 0; index < tree.children.length; index += 1) {
      const node = tree.children[index];
      if (node.type !== "element") {
        output.push(node);
        continue;
      }
      const level = numberedSectionLevel(node);
      if (level === null) {
        output.push(node);
        continue;
      }
      const section: Element["children"] = [];
      index += 1;
      while (index < tree.children.length) {
        const next = tree.children[index];
        if (next.type === "doctype") {
          output.push(next);
          index += 1;
          continue;
        }
        if (
          next.type === "element" &&
          numberedSectionLevel(next) !== null &&
          (numberedSectionLevel(next) as number) <= level
        ) {
          index -= 1;
          break;
        }
        section.push(next);
        index += 1;
      }
      output.push({
        type: "element",
        tagName: "details",
        properties: { className: ["collapsibleSection"], open: true },
        children: [
          {
            type: "element",
            tagName: "summary",
            properties: {},
            children: node.children,
          },
          ...section,
        ],
      });
    }
    tree.children = output;
  };
}
