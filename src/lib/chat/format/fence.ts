/** Fence literal source without importing browser Markdown parsing dependencies. */
export function fenceCode(text: string, language: string): string {
  let length = 3;
  for (const run of text.matchAll(/`+/g))
    length = Math.max(length, run[0].length + 1);
  const marker = "`".repeat(length);
  return `${marker}${language.replace(/[^\w+-]/g, "")}\n${text}\n${marker}`;
}
