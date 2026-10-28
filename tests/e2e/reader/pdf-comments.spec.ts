import { expect, test, type Page } from "@playwright/test";
import { restoreMayaSession } from "../support/member-session";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from "pdf-lib";

const pdfUrl = "/api/v1/papers/machine-learning/attention-is-all-you-need/pdf";
const chatsUrl =
  "/api/v1/papers/machine-learning/attention-is-all-you-need/chats";
let originalPdf: Buffer;
let temporaryChatId: string | null = null;

function annotationsOnFirstPage(document: PDFDocument) {
  const array = document.getPage(0).node.Annots();
  if (!(array instanceof PDFArray)) return [];
  return Array.from({ length: array.size() }, (_, index) => {
    const annotation = array.lookup(index, PDFDict);
    return {
      subtype: annotation.lookup(PDFName.of("Subtype"), PDFName).asString(),
      contents:
        annotation
          .lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString)
          ?.decodeText()
          .replace(/\s+/g, " ") ?? "",
      author:
        annotation
          .lookupMaybe(PDFName.of("T"), PDFString, PDFHexString)
          ?.decodeText() ?? "",
    };
  });
}

const noteContents =
  "Every token can connect directly to every other token, so long-range relationships need fewer sequential steps and training parallelizes across positions.";

async function openSeededConversation(page: Page): Promise<void> {
  // Other journeys may have created a newer empty conversation. Exercise
  // that case explicitly, then select the chat containing the note text.
  const created = await page.request.post(chatsUrl, { data: {} });
  expect(created.ok()).toBe(true);
  const payload = (await created.json()) as { chat: { id: string } };
  temporaryChatId = payload.chat.id;
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  const conversations = page.getByRole("combobox", {
    name: "Previous conversations",
  });
  await conversations.selectOption("0123456789abcdef");
  await expect(page.getByText(noteContents)).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  temporaryChatId = null;
  await restoreMayaSession(page);
  const response = await page.request.get(pdfUrl);
  expect(response.ok()).toBe(true);
  originalPdf = await response.body();
});

test.afterEach(async ({ page }) => {
  try {
    const current = await page.request.get(pdfUrl);
    expect(current.ok()).toBe(true);
    const etag = current.headers().etag;
    if (!etag) throw new Error("PDF response has no ETag");
    const restored = await page.request.put(pdfUrl, {
      headers: { "content-type": "application/pdf", "if-match": etag },
      data: originalPdf,
    });
    expect(restored.ok()).toBe(true);
  } finally {
    if (temporaryChatId) {
      const removed = await page.request.delete(
        `${chatsUrl}/${temporaryChatId}`,
        {
          data: { entire: true },
        },
      );
      expect(removed.ok()).toBe(true);
    }
  }
});

test("a reader creates, edits and deletes an attributed PDF comment", async ({
  page,
}) => {
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  const comment = page.getByRole("button", { name: "Comment", exact: true });
  const pdfPage = page.locator(".pdfViewer .page").first();
  await expect(pdfPage.locator("canvas").first()).toBeVisible();
  await comment.click();
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  await expect(comment).toHaveAttribute("aria-pressed", "false");
  await comment.click();
  await pdfPage.click({ position: { x: 100, y: 100 } });
  const dialog = page.getByRole("dialog", { name: "Add comment" });
  await dialog
    .getByRole("textbox", { name: "Comment" })
    .fill("A useful observation");
  await dialog.getByRole("button", { name: "Save comment" }).click();
  await expect(dialog).toBeHidden();
  const marker = pdfPage.locator(".textAnnotation").last();
  await expect(marker).toBeVisible();
  await marker.hover();
  const popup = page
    .locator(".popupAnnotation")
    .filter({ hasText: "A useful observation" });
  await expect(popup).toBeVisible();
  await expect(popup.getByText("Maya", { exact: true })).toBeVisible();
  await comment.click();
  await marker.click();
  const edit = page.getByRole("dialog", { name: "Edit comment" });
  await expect(edit.getByRole("textbox")).toHaveValue("A useful observation");
  await edit.getByRole("textbox").fill("Updated observation");
  await edit.getByRole("button", { name: "Save comment" }).click();
  await expect(edit).toBeHidden();
  await expect(marker).toBeVisible();
  await comment.click();
  await marker.click();
  await expect(edit.getByRole("textbox")).toHaveValue("Updated observation");
  await edit.getByRole("button", { name: "Delete comment" }).click();
  await expect(edit).toBeHidden();
  await expect(pdfPage.locator(".textAnnotation")).toHaveCount(0);
});

test("a comment draft is protected when leaving the reader", async ({
  page,
}) => {
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  const pdfPage = page.locator(".pdfViewer .page").first();
  await expect(pdfPage.locator("canvas").first()).toBeVisible();
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await pdfPage.click({ position: { x: 100, y: 100 } });
  const draft = page.getByRole("textbox", { name: "Comment" });
  await draft.fill("A comment worth keeping");

  const unloadBlocked = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(unloadBlocked).toBe(true);
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("link", { name: "Canvas", exact: true }).click();
  await expect(draft).toHaveValue("A comment worth keeping");
  await expect(page).toHaveURL(
    "/paper/machine-learning/attention-is-all-you-need",
  );

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("link", { name: "Canvas", exact: true }).click();
  await expect(page).toHaveURL(
    "/paper/machine-learning/attention-is-all-you-need/canvas",
  );
});

test("chat notes wait until a comment save and reload finish", async ({
  page,
}) => {
  await openSeededConversation(page);
  const pdfPage = page.locator(".pdfViewer .page").first();
  await expect(pdfPage.locator("canvas").first()).toBeVisible();
  const note = page.getByRole("button", {
    name: "Save as a shared note in the PDF (visible to everyone with this paper)",
  });
  await expect(note).toBeVisible();
  let release = () => {};
  let started = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/v1/papers/**/comments", async (route) => {
    started();
    await hold;
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await pdfPage.click({ position: { x: 350, y: 300 } });
    const dialog = page.getByRole("dialog", { name: "Add comment" });
    await dialog.getByRole("textbox").fill("Comment saved first");
    await dialog.getByRole("button", { name: "Save comment" }).click();
    await requestStarted;
    await note.click();
    await expect(
      page.getByText("Finish the comment before saving a note."),
    ).toBeVisible();
    release();
    await expect(dialog).toBeHidden();
    await expect(pdfPage.locator(".textAnnotation").last()).toBeVisible();
    await note.click();
    await expect(page.getByText("Note saved on page 1")).toBeVisible();
    const response = await page.request.get(
      "/api/v1/papers/machine-learning/attention-is-all-you-need/pdf",
    );
    const saved = await PDFDocument.load(await response.body());
    expect(annotationsOnFirstPage(saved)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtype: "/Text",
          contents: "Comment saved first",
          author: "Maya",
        }),
        expect.objectContaining({
          subtype: "/FreeText",
          contents: noteContents,
        }),
      ]),
    );
  } finally {
    release();
  }
});

test("a comment waits for an in-flight chat note to save and reload", async ({
  page,
}) => {
  await openSeededConversation(page);
  const pdfPage = page.locator(".pdfViewer .page").first();
  await expect(pdfPage.locator("canvas").first()).toBeVisible();
  const note = page.getByRole("button", {
    name: "Save as a shared note in the PDF (visible to everyone with this paper)",
  });
  await expect(note).toBeVisible();
  let release = () => {};
  let started = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/v1/papers/**/pdf", async (route) => {
    if (route.request().method() === "PUT") {
      started();
      await hold;
    }
    await route.continue();
  });
  try {
    await note.click();
    await requestStarted;
    const comment = page.getByRole("button", { name: "Comment", exact: true });
    await expect(comment).toBeDisabled();
    await expect(page.getByRole("dialog", { name: "Add comment" })).toHaveCount(
      0,
    );
    release();
    await expect(page.getByText("Note saved on page 1")).toBeVisible();
    await expect(pdfPage.locator(".freeTextAnnotation").first()).toBeVisible();
    await expect(comment).toBeEnabled();
    await comment.click();
    await pdfPage.click({ position: { x: 450, y: 400 } });
    const dialog = page.getByRole("dialog", { name: "Add comment" });
    await dialog.getByRole("textbox").fill("Comment saved after the note");
    await dialog.getByRole("button", { name: "Save comment" }).click();
    await expect(dialog).toBeHidden();
    const response = await page.request.get(
      "/api/v1/papers/machine-learning/attention-is-all-you-need/pdf",
    );
    const saved = await PDFDocument.load(await response.body());
    expect(annotationsOnFirstPage(saved)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtype: "/Text",
          contents: "Comment saved after the note",
          author: "Maya",
        }),
        expect.objectContaining({
          subtype: "/FreeText",
          contents: noteContents,
        }),
      ]),
    );
  } finally {
    release();
  }
});
