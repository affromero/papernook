import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

// PDF.js paints the page and its vectors on the page canvas, but composites
// embedded images using drawImage. Recolor paint operations only; image
// drawImage calls retain their pixels subject to PDF.js composition. This is
// display-only and never changes PDF data.
function darkColor(color: string): string {
  const hex = /^#([\da-f]{6})$/i.exec(color);
  const rgb =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(
      color,
    );
  if (!hex && !rgb) return color;
  const channels = hex
    ? [0, 2, 4].map(
        (offset) => parseInt(hex[1].slice(offset, offset + 2), 16) / 255,
      )
    : [Number(rgb![1]) / 255, Number(rgb![2]) / 255, Number(rgb![3]) / 255];
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  const saturation =
    chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  const luminance =
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  // Blue and violet can be very dark despite having an HSL lightness of 50%.
  // Lift those saturated colors so links stay readable against dark paper.
  const mappedLightness = Math.max(
    0.08 + 0.84 * (1 - lightness),
    saturation > 0.25 && luminance < 0.3 ? 0.72 : 0,
  );
  const mappedChroma = (1 - Math.abs(2 * mappedLightness - 1)) * saturation;
  const middle = mappedLightness - mappedChroma / 2;
  const mapped = channels.map((channel) =>
    Math.round(
      255 *
        (middle +
          (chroma === 0 ? 0 : ((channel - min) / chroma) * mappedChroma)),
    ),
  );
  return `rgba(${mapped.join(", ")}, ${rgb?.[4] ?? "1"})`;
}

type PaintMethod =
  "fill" | "fillRect" | "fillText" | "stroke" | "strokeRect" | "strokeText";

function recolorCanvas(context: CanvasRenderingContext2D): () => void {
  const saved = new Map<PaintMethod, PropertyDescriptor | undefined>();
  const methods: PaintMethod[] = [
    "fill",
    "fillRect",
    "fillText",
    "stroke",
    "strokeRect",
    "strokeText",
  ];
  for (const name of methods) {
    const original = context[name];
    const style = name.startsWith("fill") ? "fillStyle" : "strokeStyle";
    saved.set(name, Object.getOwnPropertyDescriptor(context, name));
    Object.defineProperty(context, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        const current = context[style];
        if (typeof current !== "string")
          return Reflect.apply(original, context, args);
        context[style] = darkColor(current);
        try {
          return Reflect.apply(original, context, args);
        } finally {
          context[style] = current;
        }
      },
    });
  }
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(context, name, descriptor);
      else Reflect.deleteProperty(context, name);
    }
  };
}

/** Scope recoloring to the PDFViewer's page canvases, not previews or exports.
 * The annotationCanvasMap field is supplied by the current PDF.js viewer on
 * both page and detail renders. Recheck this integration on PDF.js upgrades.
 */
export function installDarkPdfRendering(
  document: PDFDocumentProxy,
  isDark: () => boolean,
): () => void {
  const getPage = document.getPage;
  const pages = new Map<PDFPageProxy, PDFPageProxy["render"]>();
  let disposed = false;
  document.getPage = async (pageNumber) => {
    const page = await getPage.call(document, pageNumber);
    if (disposed || pages.has(page)) return page;
    const render = page.render;
    pages.set(page, render);
    page.render = (parameters) => {
      if (
        !isDark() ||
        !Object.hasOwn(parameters, "annotationCanvasMap") ||
        !(parameters.canvas instanceof HTMLCanvasElement)
      ) {
        return render.call(page, parameters);
      }
      const context = parameters.canvas.getContext("2d", {
        alpha: false,
        willReadFrequently: true,
      });
      if (!context)
        throw new Error("Could not create PDF page canvas context.");
      const restore = recolorCanvas(context);
      try {
        const task = render.call(page, parameters);
        void task.promise.then(restore, restore);
        return task;
      } catch (error) {
        restore();
        throw error;
      }
    };
    return page;
  };
  return () => {
    disposed = true;
    document.getPage = getPage;
    for (const [page, render] of pages) page.render = render;
  };
}
