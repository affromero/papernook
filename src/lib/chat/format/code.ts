import { markdownRanges } from "../normalize-math";

/** Keep literal examples out of provider markup and text normalization. */
export function protectMarkdownCode(content: string, indented = false) {
  const values: string[] = [];
  let prefix = "\u0000papernook-code:";
  while (content.includes(prefix)) prefix += ":";
  function restore(value: string): string {
    return value.replace(
      new RegExp(`${prefix}(\\d+)\u0000`, "g"),
      (_match, index: string) => {
        const saved = values[Number(index)];
        if (saved === undefined)
          throw new Error("Unknown protected code block.");
        return saved;
      },
    );
  }
  function protect(value: string): string {
    values.push(restore(value));
    return `${prefix}${values.length - 1}\u0000`;
  }
  const lines = content.split("\n");
  let text = "";
  let start = 0;
  for (let index = 0; index < lines.length; index++) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index])?.[1];
    if (!fence) continue;
    text += lines.slice(start, index).join("\n");
    if (index > start) text += "\n";
    start = index;
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
    while (++index < lines.length && !closing.test(lines[index])) {
      /* Preserve the complete code block. */
    }
    text += protect(lines.slice(start, index + 1).join("\n"));
    if (index < lines.length - 1) text += "\n";
    start = index + 1;
  }
  text += lines.slice(start).join("\n");
  text = text.replace(/(`+)[\s\S]*?\1(?!`)/g, protect);
  if (indented) text = protectIndentedCode(text, protect);
  return {
    text,
    protect,
    restore,
  };
}

/** Protect remaining literal blocks after provider containers are preserved. */
export function protectIndentedCode(
  content: string,
  protect: (value: string) => string,
): string {
  for (const range of markdownRanges(content, new Set(["code"])).reverse()) {
    content =
      content.slice(0, range.start) +
      protect(content.slice(range.start, range.end)) +
      content.slice(range.end);
  }
  return content;
}

export function fenceCode(text: string, language: string): string {
  let length = 3;
  for (const run of text.matchAll(/`+/g))
    length = Math.max(length, run[0].length + 1);
  const marker = "`".repeat(length);
  return `${marker}${language.replace(/[^\w+-]/g, "")}\n${text}\n${marker}`;
}
