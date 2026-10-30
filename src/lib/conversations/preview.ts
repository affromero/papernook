function xml(value: string | number): string {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

/** Evaluate only literal diagram coordinates, never JavaScript or property access. */
function coordinate(
  input: string,
  scope: Record<string, string | number>,
): string | number {
  const indexed = /^(\[[\s\S]*\])\[(\w+)\]$/.exec(input.trim());
  if (indexed) {
    const values: unknown = JSON.parse(indexed[1]);
    const index = Number(scope[indexed[2]]);
    const value: unknown = Array.isArray(values) ? values[index] : undefined;
    if (typeof value === "string" || typeof value === "number") return value;
    throw new Error("Unsupported diagram label.");
  }
  const tokens = input.match(/\d+(?:\.\d+)?|[a-zA-Z_]\w*|[()+*/-]/g) ?? [];
  if (tokens.join("") !== input.replace(/\s/g, ""))
    throw new Error("Unsupported diagram expression.");
  let index = 0;
  function atom(): number {
    const token = tokens[index++];
    if (token === "-") return -atom();
    if (token === "+") return atom();
    if (token === "(") {
      const value = sum();
      if (tokens[index++] !== ")")
        throw new Error("Invalid diagram coordinate.");
      return value;
    }
    const value =
      token && Object.hasOwn(scope, token)
        ? Number(scope[token])
        : Number(token);
    if (!Number.isFinite(value)) throw new Error("Invalid diagram coordinate.");
    return value;
  }
  function product(): number {
    let value = atom();
    while (tokens[index] === "*" || tokens[index] === "/") {
      const operator = tokens[index++];
      const right = atom();
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  }
  function sum(): number {
    let value = product();
    while (tokens[index] === "+" || tokens[index] === "-") {
      const operator = tokens[index++];
      const right = product();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }
  const value = sum();
  if (index !== tokens.length || !Number.isFinite(value))
    throw new Error("Invalid diagram expression.");
  return value;
}

/** Render the literal SVG and bounded coordinate loops emitted by shared chats. */
export function prepareSvg(source: string): string {
  if (source.length > 500_000)
    throw new Error("Diagram exceeds the preview limit.");
  function substitute(
    body: string,
    scope: Record<string, string | number>,
  ): string {
    return body
      .replace(
        /([\w-]+)=\{([^{}]+)\}/g,
        (_match, name: string, expression: string) =>
          `${name}="${xml(coordinate(expression, scope))}"`,
      )
      .replace(
        /(<text\b[^>]*>)([\s\S]*?)(<\/text>)/g,
        (_match, open: string, text: string, close: string) =>
          open +
          text.replace(/\{([^{}]+)\}/g, (literal, expression: string) => {
            try {
              return xml(coordinate(expression, scope));
            } catch {
              return literal;
            }
          }) +
          close,
      );
  }
  let expanded = source.replace(
    /\{#each\s+(\[[^\]]*\])\s+as\s+(\w+)\}([\s\S]*?)\{\/each\}/g,
    (_match, array: string, name: string, body: string) => {
      const values: unknown = JSON.parse(array);
      if (!Array.isArray(values) || values.length > 50)
        throw new Error("Diagram repetition exceeds the preview limit.");
      return values
        .map((value: unknown) => {
          if (typeof value !== "string" && typeof value !== "number")
            throw new Error("Unsupported diagram coordinate.");
          return substitute(body, { [name]: value });
        })
        .join("\n");
    },
  );
  expanded = substitute(expanded, {});
  // React-style SVG attributes have different names in a serialized SVG image.
  expanded = expanded.replace(
    /\b(fillOpacity|strokeOpacity|strokeWidth|strokeDasharray|strokeLinecap|strokeLinejoin|fontSize|fontWeight|textAnchor|dominantBaseline)=/g,
    (attribute) =>
      attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
  );
  if (expanded.length > 2_000_000)
    throw new Error("Expanded diagram exceeds the preview limit.");
  return expanded;
}
