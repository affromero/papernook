import { Parser } from "htmlparser2";

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: Array<XmlNode | string>;
}
export function parseXml(source: string): XmlNode {
  if (source.length > 8 * 1024 * 1024)
    throw new Error("Document XML exceeds the preview limit.");
  const root: XmlNode = { name: "root", attributes: {}, children: [] };
  const stack = [root];
  let count = 0;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (++count > 50_000 || stack.length > 80)
          throw new Error("Document structure exceeds the preview limit.");
        const node: XmlNode = {
          name: name.split(":").at(-1)!.toLowerCase(),
          attributes,
          children: [],
        };
        stack.at(-1)!.children.push(node);
        stack.push(node);
      },
      onclosetag() {
        stack.pop();
      },
      ontext(value) {
        stack.at(-1)!.children.push(value);
      },
      onprocessinginstruction(name) {
        if (name !== "?xml")
          throw new Error("Document XML declarations are unsupported.");
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.end(source);
  return root;
}
export function children(node: XmlNode, name?: string): XmlNode[] {
  return node.children.filter(
    (item): item is XmlNode =>
      typeof item !== "string" && (!name || item.name === name),
  );
}
export function descendants(node: XmlNode, name: string): XmlNode[] {
  return children(node).flatMap((child) => [
    ...(child.name === name ? [child] : []),
    ...descendants(child, name),
  ]);
}
export function xmlText(node: XmlNode): string {
  return node.children
    .map((item) =>
      typeof item === "string"
        ? item
        : item.name === "br"
          ? "\n"
          : item.name === "tab"
            ? "\t"
            : xmlText(item),
    )
    .join("");
}
