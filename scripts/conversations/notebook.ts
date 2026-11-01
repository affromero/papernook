import katex from "katex";
import { notebookPresentation } from "../../src/lib/conversations/formats/presentation";
import { object, text } from "../../src/lib/conversations/formats/schema";
import { renderHtml } from "./html";
import { prepareSvg } from "../../src/lib/conversations/preview";

export async function renderNotebook(output: unknown): Promise<void> {
  const presentation = notebookPresentation(output);
  if (presentation.kind === "html") return renderHtml(text(presentation.value));
  if (["plotly", "vega", "vega-lite", "geojson"].includes(presentation.kind)) {
    const { renderChart } = await import("./charts");
    await renderChart(presentation.kind, presentation.value);
    return;
  }
  if (presentation.kind === "widget") {
    const { renderWidget } = await import("./widgets");
    renderWidget(presentation.value, object(output)?.widgetState);
    return;
  }
  if (presentation.kind === "image" || presentation.kind === "svg") {
    const image = document.createElement("img");
    image.alt = "Notebook output";
    image.src =
      presentation.kind === "svg"
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(prepareSvg(text(presentation.value)))}`
        : `data:${presentation.mime};base64,${text(presentation.value).replace(/\s/g, "")}`;
    image.onerror = () => {
      throw new Error(
        "Notebook image could not be decoded. Its source is available below.",
      );
    };
    document.body.append(image);
    return;
  }
  const container = document.createElement(
    presentation.kind === "latex" ? "div" : "pre",
  );
  if (presentation.kind === "latex")
    katex.render(
      text(presentation.value).replace(/^\$\$?|\$\$?$/g, ""),
      container,
      { displayMode: true, trust: false, throwOnError: true, output: "mathml" },
    );
  else
    container.textContent =
      presentation.kind === "json"
        ? JSON.stringify(presentation.value, null, 2)
        : text(presentation.value);
  document.body.append(container);
}
