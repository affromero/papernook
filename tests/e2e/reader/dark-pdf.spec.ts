import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  rgb,
} from "pdf-lib";
import { restoreMayaSession } from "../support/member-session";

const pdfUrl = "/api/v1/papers/machine-learning/attention-is-all-you-need/pdf";
const pageWidth = 600;
const pageHeight = 800;
type PdfBox = { x: number; y: number; width: number; height: number };

async function screenshotRegion(page: Page, region: PdfBox): Promise<Buffer> {
  const pdfPage = page.locator(".pdfViewer .page").first();
  await pdfPage.evaluate(
    (element, sample) => {
      const container = element.closest(".pdfViewer")?.parentElement;
      if (!container) throw new Error("PDF viewport is missing");
      const pageBox = element.getBoundingClientRect();
      const viewport = container.getBoundingClientRect();
      const scale = pageBox.width / sample.pageWidth;
      const x = pageBox.left + sample.region.x * scale;
      const y =
        pageBox.top +
        (sample.pageHeight - sample.region.y - sample.region.height) * scale;
      container.scrollBy({
        left: x - viewport.left - 20,
        top: y - viewport.top - 20,
        behavior: "instant",
      });
    },
    { region, pageWidth, pageHeight },
  );
  const box = await pdfPage.boundingBox();
  if (!box) throw new Error("PDF page is not visible");
  const scale = box.width / pageWidth;
  return page.screenshot({
    clip: {
      x: box.x + region.x * scale,
      y: box.y + (pageHeight - region.y - region.height) * scale,
      width: region.width * scale,
      height: region.height * scale,
    },
  });
}

async function regionPixels(page: Page, region: PdfBox): Promise<number[][]> {
  const png = await screenshotRegion(page, region);
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not inspect the rendered page");
    context.drawImage(image, 0, 0);
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixels: number[][] = [];
    for (let i = 0; i < bytes.length; i += 4)
      pixels.push([bytes[i], bytes[i + 1], bytes[i + 2]]);
    return pixels;
  }, png.toString("base64"));
}

function luminance(pixel: number[]): number {
  const channels = pixel.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: number[], b: number[]): number {
  const left = luminance(a);
  const right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

test("dark PDF pages keep photos and readable text while preserving drafts", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await restoreMayaSession(page);
  // The high-zoom part of this test must not change Maya's saved position for
  // other browser journeys, even if the test fails midway through.
  await page
    .context()
    .route(
      "**/api/v1/papers/machine-learning/attention-is-all-you-need/position",
      async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({ json: { position: null } });
        } else if (route.request().method() === "PUT") {
          await route.fulfill({ json: { ok: true } });
        } else {
          await route.continue();
        }
      },
    );
  const original = await page.request.get(pdfUrl);
  expect(original.ok()).toBe(true);
  const originalBytes = await original.body();

  const fixture = await PDFDocument.create();
  const pdfPage = fixture.addPage([pageWidth, pageHeight]);
  const font = await fixture.embedFont(StandardFonts.Helvetica);
  const image = await fixture.embedPng(
    await readFile("public/avatars/macaw.png"),
  );
  pdfPage.drawText("Black body text", { x: 40, y: 758, size: 20, font });
  pdfPage.drawText("Green reference", {
    x: 40,
    y: 720,
    size: 20,
    font,
    color: rgb(0, 0.7, 0),
  });
  pdfPage.drawText("Blue reference", {
    x: 40,
    y: 695,
    size: 18,
    font,
    color: rgb(0, 0, 1),
  });
  pdfPage.drawText("Gray annotation", {
    x: 220,
    y: 720,
    size: 18,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });
  pdfPage.drawImage(image, { x: 40, y: 590, width: 100, height: 100 });
  pdfPage.drawRectangle({
    x: 220,
    y: 590,
    width: 160,
    height: 100,
    color: rgb(0.82, 0.94, 0.62),
  });
  pdfPage.drawText("Vector label", { x: 230, y: 635, size: 18, font });
  let renderedBytes: Buffer = Buffer.from(await fixture.save());
  await page.route(`**${pdfUrl}`, async (route) => {
    if (route.request().method() === "PUT") {
      const saved = route.request().postDataBuffer();
      if (!saved) throw new Error("No PDF was submitted");
      renderedBytes = saved;
      return route.fulfill({ json: { etag: '"fixture-saved"' } });
    }
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/pdf",
      body: renderedBytes,
      headers: {
        "content-length": String(renderedBytes.byteLength),
        "cache-control": "no-store",
        etag: '"fixture-saved"',
      },
    });
  });

  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  const pdfCanvas = page.locator(".pdfViewer .page canvas").first();
  await expect(pdfCanvas).toBeVisible();
  const appearance = page.getByRole("combobox", {
    name: "Document appearance",
  });
  await appearance.selectOption("light");
  const paper = { x: 5, y: 790, width: 5, height: 5 };
  const raster = { x: 48, y: 598, width: 84, height: 84 };
  await expect
    .poll(async () => luminance((await regionPixels(page, paper))[0]))
    .toBeGreaterThan(0.8);
  await expect
    .poll(async () =>
      (await regionPixels(page, raster)).some(
        (pixel) => Math.max(...pixel) - Math.min(...pixel) > 40,
      ),
    )
    .toBe(true);
  const lightImage = await screenshotRegion(page, raster);
  await appearance.selectOption("dark");
  await expect
    .poll(async () => luminance((await regionPixels(page, paper))[0]), {
      timeout: 15_000,
    })
    .toBeLessThan(0.08);
  await expect
    .poll(async () => (await screenshotRegion(page, raster)).equals(lightImage))
    .toBe(true);

  const darkPaper = (await regionPixels(page, paper))[0];
  const bodyText = await regionPixels(page, {
    x: 40,
    y: 755,
    width: 160,
    height: 25,
  });
  const linkText = await regionPixels(page, {
    x: 40,
    y: 718,
    width: 160,
    height: 25,
  });
  expect(
    Math.max(...bodyText.map((pixel) => contrast(pixel, darkPaper))),
  ).toBeGreaterThan(4.5);
  expect(
    Math.max(...linkText.map((pixel) => contrast(pixel, darkPaper))),
  ).toBeGreaterThan(3);
  const blueText = await regionPixels(page, {
    x: 40,
    y: 693,
    width: 160,
    height: 23,
  });
  const grayText = await regionPixels(page, {
    x: 220,
    y: 718,
    width: 160,
    height: 23,
  });
  expect(
    Math.max(...blueText.map((pixel) => contrast(pixel, darkPaper))),
  ).toBeGreaterThan(3);
  expect(
    Math.max(...grayText.map((pixel) => contrast(pixel, darkPaper))),
  ).toBeGreaterThan(3);
  const vectorBackground = (
    await regionPixels(page, { x: 225, y: 595, width: 4, height: 4 })
  )[0];
  const vectorText = await regionPixels(page, {
    x: 230,
    y: 633,
    width: 110,
    height: 24,
  });
  expect(
    Math.max(...vectorText.map((pixel) => contrast(pixel, vectorBackground))),
  ).toBeGreaterThan(3);

  const comment = page.getByRole("button", { name: "Comment", exact: true });
  await comment.click();
  await page
    .locator(".pdfViewer .page")
    .first()
    .click({ position: { x: 10, y: 10 } });
  const draft = page
    .getByRole("dialog", { name: "Add comment" })
    .getByRole("textbox");
  await draft.fill("An unsaved annotation");
  await appearance.selectOption("light");
  await expect(draft).toHaveValue("An unsaved annotation");
  await expect
    .poll(async () => luminance((await regionPixels(page, paper))[0]), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0.8);
  await appearance.selectOption("dark");
  await expect(draft).toHaveValue("An unsaved annotation");
  await page
    .getByRole("dialog", { name: "Add comment" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page
    .locator(".pdfViewer .page")
    .first()
    .click({ position: { x: 300, y: 180 } });
  const textEditor = page.locator(".freeTextEditor .internal").first();
  await expect(textEditor).toBeVisible();
  await page.keyboard.type("A note that must survive");
  await appearance.selectOption("light");
  await expect(textEditor).toContainText("A note that must survive");
  await appearance.selectOption("dark");
  await expect(textEditor).toContainText("A note that must survive");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Save annotations in PDF" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const savedDocument = await PDFDocument.load(renderedBytes);
  const annotations = savedDocument.getPage(0).node.Annots();
  expect(annotations).toBeDefined();
  const savedText = Array.from({ length: annotations!.size() }, (_, index) =>
    annotations!
      .lookup(index, PDFDict)
      .lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString)
      ?.decodeText(),
  );
  expect(savedText).toContain("A note that must survive");
  await page.reload();
  await expect(pdfCanvas).toBeVisible();
  const zoomIn = page.getByRole("button", { name: "Zoom in" });
  for (let i = 0; i < 25; i++) await zoomIn.click();
  await page.locator(".pdfViewer").evaluate((viewer) => {
    if (!viewer.parentElement) throw new Error("PDF viewport is missing");
    viewer.parentElement.scrollTo(0, 0);
  });
  const expectRestrictedScale = async () => {
    await expect
      .poll(
        () =>
          pdfCanvas.evaluate(
            (canvas: HTMLCanvasElement) =>
              canvas.width / canvas.getBoundingClientRect().width,
          ),
        { timeout: 15_000 },
      )
      .toBeLessThan(0.95);
  };
  await expectRestrictedScale();
  await appearance.selectOption("light");
  await expect
    .poll(async () => luminance((await regionPixels(page, paper))[0]), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0.8);
  await expectRestrictedScale();
  await appearance.selectOption("dark");
  await expect
    .poll(async () => luminance((await regionPixels(page, paper))[0]), {
      timeout: 15_000,
    })
    .toBeLessThan(0.08);
  await expectRestrictedScale();
  const after = await page.request.get(pdfUrl);
  expect(after.ok()).toBe(true);
  expect((await after.body()).equals(originalBytes)).toBe(true);
  expect(after.headers().etag).toBe(original.headers().etag);
});
