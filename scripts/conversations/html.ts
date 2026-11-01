import DOMPurify from "dompurify";

export async function renderHtml(source: string): Promise<void> {
  const scripts: {
    text: string;
    type: string;
    id: string;
    external: boolean;
  }[] = [];
  const handlers: { node: Element; name: string; text: string }[] = [];
  DOMPurify.addHook("uponSanitizeElement", (node, event) => {
    if (event.tagName === "script" && node instanceof HTMLScriptElement)
      scripts.push({
        text: node.textContent ?? "",
        type: node.type,
        id: node.id,
        external: node.hasAttribute("src"),
      });
  });
  DOMPurify.addHook("uponSanitizeAttribute", (node, event) => {
    if (/^on[a-z0-9]+$/.test(event.attrName))
      handlers.push({ node, name: event.attrName, text: event.attrValue });
  });
  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(source, {
      RETURN_DOM_FRAGMENT: true,
      FORCE_BODY: true,
    });
  } finally {
    DOMPurify.removeHooks("uponSanitizeElement");
    DOMPurify.removeHooks("uponSanitizeAttribute");
  }
  if (scripts.some((script) => script.external))
    throw new Error(
      "This artifact requires an external script that is not included in the import.",
    );
  document.body.append(fragment);
  const connected = handlers.filter((handler) => handler.node.isConnected);
  Object.defineProperty(globalThis, "papernookArtifactNodes", {
    value: connected.map((handler) => handler.node),
    configurable: true,
  });
  const bindings = document.createElement("script");
  bindings.textContent = `(() => { const nodes = globalThis.papernookArtifactNodes; delete globalThis.papernookArtifactNodes; ${connected.map((handler, index) => `nodes[${index}][${JSON.stringify(handler.name)}] = function(event) {\n${handler.text}\n};`).join("\n")} })();`;
  document.body.append(bindings);
  for (const original of scripts) {
    const script = document.createElement("script");
    if (original.type) script.type = original.type;
    if (original.id) script.id = original.id;
    script.textContent = original.text;
    document.body.append(script);
  }
}
