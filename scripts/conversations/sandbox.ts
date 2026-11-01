import mermaid from "mermaid";
import DOMPurify from "dompurify";
import { prepareSvg } from "../../src/lib/conversations/preview";
import { object } from "../../src/lib/conversations/formats/schema";
import { renderHtml } from "./html";
import { enableSnapshots } from "./snapshots";

async function render(): Promise<void> {
  if (window.parent === window || globalThis.origin !== "null")
    throw new Error(
      "Open this preview inside the isolated conversation reader.",
    );
  const payload = object(
    JSON.parse(decodeURIComponent(location.hash.slice(1))) as unknown,
  );
  if (
    !payload ||
    typeof payload.source !== "string" ||
    payload.source.length > 500_000
  )
    throw new Error("Invalid preview source.");
  const { source, kind } = payload;
  if (kind === "svg-preview") {
    const image = document.createElement("img");
    image.alt = "Imported SVG diagram";
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(prepareSvg(source))}`;
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
  } else if (kind === "html-preview") await renderHtml(source);
  else if (kind === "react-preview") {
    const { renderReact } = await import("./react");
    await renderReact(source);
  } else if (kind === "notebook-preview") {
    const { renderNotebook } = await import("./notebook");
    await renderNotebook(JSON.parse(source) as unknown);
  } else if (kind === "mcp-preview") {
    const snapshot = object(JSON.parse(source) as unknown);
    if (!snapshot || typeof snapshot.template !== "string")
      throw new Error("This app is missing its exported display template.");
    Object.defineProperty(globalThis, "openai", {
      value: Object.freeze({
        toolOutput: snapshot.structuredContent,
        toolResponseMetadata: {},
        locale: "en",
        displayMode: "inline",
      }),
      configurable: true,
    });
    Object.defineProperty(globalThis, "papernookSnapshot", {
      value: snapshot.structuredContent,
      configurable: true,
    });
    await renderHtml(snapshot.template);
    window.dispatchEvent(
      new CustomEvent("openai:set_globals", {
        detail: { globals: { toolOutput: snapshot.structuredContent } },
      }),
    );
    const saved = document.createElement("details");
    const label = document.createElement("summary");
    label.textContent = "Saved app data";
    const data = document.createElement("pre");
    data.textContent = JSON.stringify(snapshot.structuredContent, null, 2);
    saved.append(label, data);
    document.body.append(saved);
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
  error.textContent = message.slice(0, 500);
  document.body.append(error);
}
window.addEventListener("error", (event) =>
  reportError(
    event.error instanceof Error
      ? event.error.message
      : "The artifact could not finish rendering. Its source is available below.",
  ),
);
window.addEventListener("unhandledrejection", (event) =>
  reportError(
    event.reason instanceof Error
      ? event.reason.message
      : "The artifact could not finish rendering. Its source is available below.",
  ),
);
const ready = render();
enableSnapshots(ready);
void ready.catch((error: unknown) =>
  reportError(error instanceof Error ? error.message : "Preview failed."),
);
