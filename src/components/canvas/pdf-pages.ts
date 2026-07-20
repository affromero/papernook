import {
  AssetRecordType,
  createShapeId,
  type Editor,
  type TLImageShape,
  type TLShape,
} from "tldraw";

const PAGE_GAP = 48;
const RENDER_SCALE = 1.6;
const PAGE_SHAPE_PATTERN = /^shape:page-(\d+)$/;

interface StoredPdfPage {
  src: string;
  width: number;
  height: number;
}

export interface PdfPageSyncResult {
  changed: boolean;
  imported: boolean;
  obsoleteSources: string[];
  version: string;
}

export function focusFirstPdfPage(editor: Editor): void {
  const bounds = editor.getShapePageBounds(createShapeId("page-1"));
  if (bounds) {
    editor.zoomToBounds(bounds, {
      animation: { duration: 0 },
      inset: 48,
    });
  } else {
    editor.zoomToFit({ animation: { duration: 0 } });
  }
}

function pageShapes(editor: Editor): TLShape[] {
  return editor.store
    .allRecords()
    .filter(
      (record): record is TLShape =>
        record.typeName === "shape" && PAGE_SHAPE_PATTERN.test(record.id),
    );
}

function hasCurrentPages(editor: Editor, version: string): boolean {
  const pages = pageShapes(editor);
  const first = editor.getShape(createShapeId("page-1"));
  if (!first || first.type !== "image") return false;
  const expectedCount = first.meta.papernookPdfPageCount;
  if (
    first.meta.papernookPdfVersion !== version ||
    typeof expectedCount !== "number" ||
    expectedCount <= 0 ||
    pages.length !== expectedCount
  ) {
    return false;
  }
  for (let pageNumber = 1; pageNumber <= expectedCount; pageNumber += 1) {
    const page = editor.getShape(createShapeId(`page-${pageNumber}`));
    if (
      !page ||
      page.type !== "image" ||
      page.meta.papernookPdfPageNumber !== pageNumber ||
      page.meta.papernookPdfPageCount !== expectedCount ||
      page.meta.papernookPdfVersion !== version ||
      !page.props.assetId
    ) {
      return false;
    }
    const asset = editor.getAsset(page.props.assetId);
    if (asset?.type !== "image" || !asset.props.src) return false;
  }
  return true;
}

function retryDelay(response: Response, attempt: number): number | null {
  if (response.status !== 409 || attempt >= 3) return null;
  const retryAfter = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1_000, 5_000)
    : 500;
}

async function fetchPdf(
  url: string,
  method: "GET" | "HEAD",
): Promise<Response> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      credentials: "same-origin",
    });
    const delay = retryDelay(response, attempt);
    if (delay === null) return response;
    await new Promise((resolve) => window.setTimeout(resolve, delay));
  }
  throw new Error("The PDF remained busy after retrying.");
}

async function currentPdfVersion(url: string): Promise<string> {
  const response = await fetchPdf(url, "HEAD");
  if (!response.ok) {
    throw new Error(
      `The PDF version could not be checked (${response.status}).`,
    );
  }
  const version = response.headers.get("etag");
  if (!version) throw new Error("The PDF did not include a version.");
  return version;
}

async function renderAndStorePdfPages(
  url: string,
  upload: (blob: Blob, filename: string) => Promise<string>,
): Promise<{ pages: StoredPdfPage[]; version: string }> {
  const response = await fetchPdf(url, "GET");
  if (!response.ok) {
    throw new Error(`The PDF could not be loaded (${response.status}).`);
  }
  const version = response.headers.get("etag");
  if (!version) throw new Error("The PDF did not include a version.");

  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await response.arrayBuffer()),
  });
  const document = await loadingTask.promise;
  const pages: StoredPdfPage[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The PDF page could not be rendered.");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error("The PDF page image could not be created."));
        }, "image/png");
      });
      pages.push({
        src: await upload(blob, `page-${pageNumber}.png`),
        width: viewport.width / RENDER_SCALE,
        height: viewport.height / RENDER_SCALE,
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return { pages, version };
}

function applyPdfPages(
  editor: Editor,
  pages: StoredPdfPage[],
  version: string,
): { imported: boolean; obsoleteSources: string[] } {
  const existingPages = pageShapes(editor);
  const imported = existingPages.length === 0;
  const obsoleteSources = new Set<string>();
  let nextY = 0;

  editor.run(
    () => {
      for (const [index, page] of pages.entries()) {
        const pageNumber = index + 1;
        const shapeId = createShapeId(`page-${pageNumber}`);
        const existing = editor.getShape(shapeId);
        const existingImage = existing?.type === "image" ? existing : null;
        const existingAsset = existingImage?.props.assetId
          ? editor.getAsset(existingImage.props.assetId)
          : null;
        if (
          existingAsset?.type === "image" &&
          existingAsset.props.src &&
          existingAsset.props.src !== page.src
        ) {
          obsoleteSources.add(existingAsset.props.src);
        }
        const assetId =
          existingImage?.props.assetId ??
          AssetRecordType.createId(`pdf-page-${pageNumber}`);
        const assetProps = {
          name: `page-${pageNumber}.png`,
          src: page.src,
          w: page.width,
          h: page.height,
          mimeType: "image/png" as const,
          isAnimated: false,
        };
        const meta = {
          papernookPdfPageNumber: pageNumber,
          papernookPdfPageCount: pages.length,
          papernookPdfVersion: version,
        };

        if (editor.getAsset(assetId)) {
          editor.updateAssets([
            { id: assetId, type: "image", props: assetProps },
          ]);
        } else {
          editor.createAssets([
            {
              id: assetId,
              typeName: "asset",
              type: "image",
              meta: {},
              props: assetProps,
            },
          ]);
        }

        if (existingImage) {
          editor.updateShape<TLImageShape>({
            id: existingImage.id,
            type: "image",
            isLocked: true,
            meta,
            props: { assetId, w: page.width, h: page.height },
          });
          nextY = Math.max(nextY, existingImage.y + page.height + PAGE_GAP);
        } else {
          editor.createShape<TLImageShape>({
            id: shapeId,
            type: "image",
            x: 0,
            y: nextY,
            isLocked: true,
            meta,
            props: { assetId, w: page.width, h: page.height },
          });
          nextY += page.height + PAGE_GAP;
        }
      }

      for (const shape of existingPages) {
        const match = PAGE_SHAPE_PATTERN.exec(shape.id);
        if (match && Number(match[1]) > pages.length) {
          editor.deleteShape(shape.id);
        }
      }
    },
    { history: "ignore", ignoreShapeLock: true },
  );
  return { imported, obsoleteSources: [...obsoleteSources] };
}

export async function syncPdfPages(
  editor: Editor,
  url: string,
  upload: (blob: Blob, filename: string) => Promise<string>,
  force = false,
): Promise<PdfPageSyncResult> {
  const checkedVersion = await currentPdfVersion(url);
  if (!force && hasCurrentPages(editor, checkedVersion)) {
    return {
      changed: false,
      imported: false,
      obsoleteSources: [],
      version: checkedVersion,
    };
  }
  const rendered = await renderAndStorePdfPages(url, upload);
  if (!force && hasCurrentPages(editor, rendered.version)) {
    return {
      changed: false,
      imported: false,
      obsoleteSources: [],
      version: rendered.version,
    };
  }
  const result = applyPdfPages(editor, rendered.pages, rendered.version);
  return { changed: true, version: rendered.version, ...result };
}
