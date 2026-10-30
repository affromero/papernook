/** Keep literal examples out of provider markup and text normalization. */
export function protectMarkdownCode(content: string) {
  const values: string[] = [];
  let prefix = "\u0000papernook-code:";
  while (content.includes(prefix)) prefix += ":";
  function protect(value: string): string {
    values.push(value);
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
  return {
    text: text.replace(/(`+)[\s\S]*?\1(?!`)/g, protect),
    protect,
    restore(value: string): string {
      return value.replace(
        new RegExp(`${prefix}(\\d+)\u0000`, "g"),
        (_match, index: string) => values[Number(index)],
      );
    },
  };
}

export function fenceCode(text: string, language: string): string {
  let length = 3;
  for (const run of text.matchAll(/`+/g))
    length = Math.max(length, run[0].length + 1);
  const marker = "`".repeat(length);
  return `${marker}${language.replace(/[^\w+-]/g, "")}\n${text}\n${marker}`;
}
