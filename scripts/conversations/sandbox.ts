import mermaid from "mermaid";
import DOMPurify from "dompurify";
import { prepareSvg } from "../../src/lib/conversations/preview";

async function render(): Promise<void> {
  const payload: unknown = JSON.parse(
    decodeURIComponent(location.hash.slice(1)),
  );
  if (
    !payload ||
    typeof payload !== "object" ||
    !("kind" in payload) ||
    !("source" in payload) ||
    typeof payload.source !== "string" ||
    payload.source.length > 500_000
  )
    throw new Error("Invalid preview source.");
  const { source, kind } = payload;
  if (kind === "svg-preview") {
    const image = document.createElement("img");
    image.alt = "Imported SVG diagram";
    image.src = URL.createObjectURL(
      new Blob([prepareSvg(source)], { type: "image/svg+xml" }),
    );
    image.onerror = () =>
      reportError(
        "The SVG could not be rendered. Its source is available below.",
      );
    document.body.append(image);
  } else if (kind === "mermaid") {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 100_000,
      htmlLabels: false,
    });
    const result = await mermaid.render("imported-diagram", source);
    document.body.append(
      DOMPurify.sanitize(result.svg, {
        RETURN_DOM_FRAGMENT: true,
        USE_PROFILES: { svg: true, svgFilters: true },
      }),
    );
  } else if (kind === "html-preview") {
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
  } else throw new Error("Unsupported preview format.");
  const resize = () =>
    parent.postMessage(
      {
        type: "papernook-preview-size",
        height: Math.min(1600, Math.max(200, document.body.scrollHeight + 32)),
      },
      "*",
    );
  new ResizeObserver(resize).observe(document.body);
  resize();
}
function reportError(message: string): void {
  parent.postMessage(
    { type: "papernook-preview-error", message: message.slice(0, 500) },
    "*",
  );
  const error = document.createElement("p");
  error.textContent = message;
  document.body.append(error);
}
window.addEventListener("error", () =>
  reportError(
    "The artifact could not finish rendering. Its source is available below.",
  ),
);
window.addEventListener("unhandledrejection", () =>
  reportError(
    "The artifact could not finish rendering. Its source is available below.",
  ),
);
void render().catch((error: unknown) =>
  reportError(error instanceof Error ? error.message : "Preview failed."),
);
