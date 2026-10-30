import { expect, test, type Page } from "@playwright/test";
import http from "node:http";
import { restoreMayaSession } from "../support/member-session";
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFString,
  PDFHexString,
} from "pdf-lib";
import fs from "node:fs/promises";
import path from "node:path";

const source = "/api/v1/papers/machine-learning/attention-is-all-you-need";
let originalPdf: Buffer;
let shareId: string | null;
let copyPath: string | null;

async function saveAnnotations(page: Page, base: string) {
  await expect(
    page.getByRole("button", { name: "Save annotations in PDF" }),
  ).toBeEnabled();
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(`${base}/pdf`),
  );
  await page.getByRole("button", { name: "Save annotations in PDF" }).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(page.locator(".freeTextAnnotation").first()).toBeVisible({
    timeout: 30_000,
  });
}

function annotationValues(document: PDFDocument) {
  return (document.getPage(0).node.Annots()?.asArray() ?? []).map((ref) => {
    const dict = document.context.lookup(ref, PDFDict);
    const text = (key: string) =>
      dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)?.decodeText();
    return {
      type: dict.get(PDFName.of("Subtype"))?.toString(),
      content: text("Contents"),
      name: text("NM"),
      author: text("T"),
      actor: text("PapernookAuthor"),
    };
  });
}

test.beforeEach(async ({ page }) => {
  shareId = null;
  copyPath = null;
  await restoreMayaSession(page);
  originalPdf = await (await page.request.get(`${source}/pdf`)).body();
});
test.afterEach(async ({ page }) => {
  if (shareId) await page.request.delete(`${source}/shares/${shareId}`);
  if (copyPath)
    await page.request.delete(copyPath.replace("/paper/", "/api/v1/papers/"));
  const current = await page.request.get(`${source}/pdf`);
  if (current.ok()) {
    await new Promise((resolve) => setTimeout(resolve, 5200));
    await page.request.put(`${source}/pdf`, {
      headers: {
        "Content-Type": "application/pdf",
        "If-Match": current.headers().etag,
      },
      data: originalPdf,
    });
  }
});

test("forks annotated readings without establishing an upstream connection", async ({
  page,
}) => {
  const created = await page.request.post(`${source}/shares`, {
    data: { mode: "fork", chatIds: ["0123456789abcdef"] },
  });
  expect(created.ok()).toBe(true);
  const { share } = await created.json();
  shareId = share.id;
  await page.goto(
    `/sharing/import?url=${encodeURIComponent(`https://127.0.0.1:3148${share.href}`)}`,
  );
  await page.getByLabel("Topic", { exact: true }).fill("shared-forks");
  await page.getByRole("button", { name: "Import independent fork" }).click();
  await expect(page).toHaveURL(/\/paper\/shared-forks\//, { timeout: 30_000 });
  copyPath = new URL(page.url()).pathname;
  const copyBase = copyPath.replace("/paper/", "/api/v1/papers/");
  expect(await (await page.request.get(`${copyBase}/pdf`)).body()).toEqual(
    originalPdf,
  );
  const chats = await (await page.request.get(`${copyBase}/chats`)).json();
  expect(
    chats.chats.some((chat: { title: string }) => chat.title.includes("Maya")),
  ).toBe(true);
  const state = await (
    await page.request.get(`${copyBase}/collaboration`)
  ).json();
  expect(state.connected).toBe(false);
  await page.request.delete(`${source}/shares/${shareId}`);
  shareId = null;
  expect((await page.request.get(`${copyBase}/pdf`)).ok()).toBe(true);
});

test("requires approval, attributes shared annotations, publishes chats and enforces revocation", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const created = await page.request.post(`${source}/shares`, {
    data: {
      mode: "collaborate",
      chatIds: [],
      acknowledgePublicAnnotations: true,
    },
  });
  expect(created.ok()).toBe(true);
  const { share } = await created.json();
  shareId = share.id;
  await page.goto(
    `/sharing/import?mode=collaborate&url=${encodeURIComponent(`https://127.0.0.1:3148${share.href}`)}`,
  );
  await page.getByLabel("Topic", { exact: true }).fill("shared-work");
  await page.getByRole("checkbox", { name: /I understand/ }).check();
  await page.getByRole("button", { name: "Import and request access" }).click();
  await expect(page).toHaveURL(/\/paper\/shared-work\//, { timeout: 30_000 });
  copyPath = new URL(page.url()).pathname;
  const copyBase = copyPath.replace("/paper/", "/api/v1/papers/");
  await expect(page.getByText(/Your verification code:/)).toBeVisible({
    timeout: 30_000,
  });
  expect((await page.request.get(`${copyBase}/pdf`)).status()).toBe(403);
  const participants = await (
    await page.request.get(`${source}/shares/${shareId}/participants`)
  ).json();
  const participant = participants.participants.find(
    (p: { status: string }) => p.status === "pending",
  );
  expect(participant.id).toMatch(/^[a-f0-9]{16}$/);
  expect(
    (
      await page.request.patch(`${source}/shares/${shareId}/participants`, {
        data: {
          id: participant.id,
          status: "approved",
          name: "Maya Collaborator",
        },
      })
    ).ok(),
  ).toBe(true);
  // Import and the preceding fixture restoration are external writes from the
  // reader's perspective. Respect the same recent-write guard as WebDAV.
  await new Promise((resolve) => setTimeout(resolve, 5200));
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page
    .locator(".pdfViewer .page")
    .first()
    .click({ position: { x: 300, y: 180 } });
  const editor = page.locator(".freeTextEditor .internal").first();
  await expect(editor).toBeVisible();
  await page.keyboard.type("A collaboratively saved text annotation");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await saveAnnotations(page, copyBase);
  const first = annotationValues(
    await PDFDocument.load(
      await (await page.request.get(`${source}/pdf`)).body(),
    ),
  ).find(
    (annotation) =>
      annotation.content === "A collaboratively saved text annotation",
  )!;
  expect(first.author).toBe("Maya Collaborator");
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const existingEditor = page
    .locator(".freeTextEditor .internal")
    .filter({ hasText: "A collaboratively saved text annotation" });
  await expect(existingEditor).toBeVisible();
  await page
    .locator(".freeTextEditor")
    .filter({ hasText: "A collaboratively saved text annotation" })
    .dblclick();
  await expect(existingEditor).toHaveAttribute("contenteditable", "true");
  await existingEditor.fill("An updated collaborative annotation");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await saveAnnotations(page, copyBase);
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  const box = (await page.locator(".pdfViewer .page").first().boundingBox())!;
  await page.mouse.move(box.x + 260, box.y + 240);
  await page.mouse.down();
  await page.mouse.move(box.x + 310, box.y + 260, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await saveAnnotations(page, copyBase);
  const thirdResponse = await page.request.get(`${source}/pdf`);
  const thirdBytes = await thirdResponse.body();
  const third = annotationValues(await PDFDocument.load(thirdBytes));
  expect(
    third.filter(
      (annotation) =>
        annotation.content === "An updated collaborative annotation",
    ),
  ).toEqual([
    expect.objectContaining({
      name: first.name,
      author: "Maya Collaborator",
      actor: `participant:${participant.id}`,
    }),
  ]);
  expect(
    third.some(
      (annotation) =>
        annotation.type === "/Ink" && annotation.author === "Maya Collaborator",
    ),
  ).toBe(true);
  const unchanged = await page.request.put(`${copyBase}/pdf`, {
    headers: {
      "Content-Type": "application/pdf",
      "If-Match": thirdResponse.headers().etag,
    },
    data: thirdBytes,
  });
  expect(unchanged.ok(), await unchanged.text()).toBe(true);
  expect((await unchanged.json()).etag).toBe(thirdResponse.headers().etag);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const leavingEditor = page
    .locator(".freeTextEditor")
    .filter({ hasText: "An updated collaborative annotation" });
  await leavingEditor.dblclick();
  await leavingEditor
    .locator(".internal")
    .fill("Saved while leaving the reader");
  await page
    .getByRole("link", { name: /Library/ })
    .first()
    .click();
  await expect(page).toHaveURL("/", { timeout: 30_000 });
  const afterLeaving = annotationValues(
    await PDFDocument.load(
      await (await page.request.get(`${source}/pdf`)).body(),
    ),
  );
  expect(afterLeaving).toContainEqual(
    expect.objectContaining({
      content: "Saved while leaving the reader",
      name: first.name,
    }),
  );
  await page.goto(copyPath);
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  const opened = await page.request.get(`${copyBase}/pdf`);
  expect(opened.ok()).toBe(true);
  const saved = await page.request.post(`${copyBase}/comments`, {
    headers: { "If-Match": opened.headers().etag },
    data: {
      action: "create",
      page: 1,
      x: 100,
      y: 100,
      text: "A note from the approved collaborator",
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const sourcePdf = await (await page.request.get(`${source}/pdf`)).body();
  const document = await PDFDocument.load(sourcePdf);
  const note = annotationValues(document).find(
    (value) => value.content === "A note from the approved collaborator",
  );
  expect(note).toMatchObject({
    author: "Maya Collaborator",
    actor: `participant:${participant.id}`,
  });
  const { chat } = await (
    await page.request.post(`${copyBase}/chats`, { data: {} })
  ).json();
  const [, , topic, slug] = copyPath.split("/");
  await fs.appendFile(
    path.join(
      process.cwd(),
      ".playwright-data/library",
      topic,
      slug,
      "chats/maya",
      `${chat.id}.jsonl`,
    ),
    JSON.stringify({
      role: "user",
      content: "A conversation explicitly shared with collaborators",
      at: new Date().toISOString(),
    }) + "\n",
  );
  expect(
    (
      await page.request.post(`${copyBase}/collaboration`, {
        data: { chatId: chat.id },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(page.getByText(/Your verification code:/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Text", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".pdfViewer .page canvas").first()).toBeVisible();
  await expect(page).toHaveScreenshot(["product", "collaboration.png"], {
    animations: "disabled",
    maxDiffPixelRatio: 0.06,
  });
  const sourceSharing = await (
    await page.request.get(`${source}/collaboration`)
  ).json();
  expect(
    sourceSharing.threads.some(
      (thread: { author: string; chat: { messages: { content: string }[] } }) =>
        thread.author === "Maya Collaborator" &&
        thread.chat.messages.some((message) =>
          message.content.includes("explicitly shared"),
        ),
    ),
  ).toBe(true);
  await page.goto(share.href);
  await expect(page.getByText(/View only/)).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("A conversation explicitly shared with collaborators"),
  ).toHaveCount(0);
  expect(
    (
      await page.request.patch(`${source}/shares/${shareId}/participants`, {
        data: { id: participant.id, status: "revoked" },
      })
    ).ok(),
  ).toBe(true);
  expect((await page.request.get(`${copyBase}/pdf`)).status()).toBe(403);
});

test("rejects an unauthorized upload before buffering its unfinished body", async ({
  page,
}) => {
  const created = await page.request.post(`${source}/shares`, {
    data: {
      mode: "collaborate",
      chatIds: [],
      acknowledgePublicAnnotations: true,
    },
  });
  const { share } = await created.json();
  shareId = share.id;
  const cookie = (await page.context().cookies())
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  for (const attempt of [
    {
      topic: "machine-learning",
      headers: { Authorization: "Bearer invalid" },
      status: 401,
    },
    { topic: "machine-learning", headers: { Cookie: cookie }, status: 401 },
    {
      topic: "INVALID",
      headers: { Authorization: "Bearer invalid" },
      status: 404,
    },
    {
      topic: "machine-learning",
      headers: {
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      status: 403,
    },
  ]) {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: 3107,
          path: `/api/v1/shares/${attempt.topic}/attention-is-all-you-need/${share.id}/exchange`,
          method: "POST",
          headers: {
            ...attempt.headers,
            "X-Sharing-Operation": "save-pdf",
            "Content-Type": "application/json",
            "Content-Length": "100000000",
          },
        },
        (response) => {
          clearTimeout(deadline);
          resolve(response.statusCode ?? 500);
          response.resume();
          request.destroy();
        },
      );
      const deadline = setTimeout(() => {
        request.destroy();
        reject(
          new Error("The server buffered an unauthorized unfinished upload."),
        );
      }, 10_000);
      request.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      request.write(" ".repeat(1024));
    });
    expect(status).toBe(attempt.status);
  }
});

test("keeps sharing choices usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/paper/machine-learning/attention-is-all-you-need");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("radio", { name: /Collaborate/ }).check();
  const create = page.getByRole("button", { name: "Create link & copy" });
  await expect(create).toBeDisabled();
  await page
    .getByRole("checkbox", { name: /Share the same annotated PDF/ })
    .check();
  await expect(create).toBeEnabled();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
  ).toBe(true);
  expect(
    await page
      .getByRole("dialog")
      .locator("small, p")
      .evaluateAll((elements) =>
        elements.every((element) => element.scrollWidth <= element.clientWidth),
      ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page).toHaveScreenshot(["product", "share-reading-mobile.png"], {
    animations: "disabled",
    maxDiffPixelRatio: 0.06,
  });
});
