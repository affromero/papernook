import mermaid from "mermaid";
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
    });
    const result = await mermaid.render("imported-diagram", source);
    const container = document.createElement("div");
    container.innerHTML = result.svg;
    document.body.append(container);
  } else if (kind === "html-preview") {
    const template = document.createElement("template");
    template.innerHTML = source;
    const scripts = [...template.content.querySelectorAll("script")];
    for (const script of scripts) script.remove();
    document.body.append(template.content);
    for (const original of scripts) {
      if (original.src)
        throw new Error(
          "This artifact requires an external script that is not included in the import.",
        );
      const script = document.createElement("script");
      if (original.type) script.type = original.type;
      script.textContent = original.textContent;
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
